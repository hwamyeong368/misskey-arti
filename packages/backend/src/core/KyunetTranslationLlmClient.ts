/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only OpenAI-compatible Chat Completions client for LLM translation (spec 5.3).
// Builds the request body, sends it through HttpRequestService and validates the JSON reply.

import { Injectable } from '@nestjs/common';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { bindThis } from '@/decorators.js';
import type { KyunetMaxTokensParam, MiKyunetTranslationSetting } from '@/models/KyunetTranslationSetting.js';

export type TranslationKind = 'note' | 'user_name' | 'user_description' | 'user_field_name' | 'user_field_value';
export type LlmInputItem = { i: number; kind: TranslationKind; text: string };
export type LlmOutputItem = { i: number; sourceLangs: string[]; text: string };

export type KyunetLlmErrorReason = 'http' | 'timeout' | 'length' | 'invalid_json' | 'count_mismatch' | 'invalid_item' | 'no_choice';

export class KyunetLlmError extends Error {
	constructor(public readonly reason: KyunetLlmErrorReason, message?: string) {
		super(message ?? reason);
		this.name = 'KyunetLlmError';
	}
}

export const MAX_COMPLETION_TOKENS_CAP = 8192;

// Deliberately short: measured against a small model (gemma-4-26B), every extra conditional rule cost compliance
// elsewhere. Only unconditional instructions remain; "nothing to translate" is detected server-side (text unchanged).
export const DEFAULT_SYSTEM_PROMPT = `You translate texts from a Misskey (fediverse) server into the target language given in the input. Each input item has an index i, a kind (note, user_name, user_description, user_field_name, user_field_value) and a text. Reply with JSON only.

- Translate each item by itself; do not mix items.
- Translate naturally in the original's tone. Keep line breaks. Add nothing of your own.
- Keep MFM markup such as $[...] and **...** as it is, and translate the text inside.
- Translate #hashtags too, without spaces (#今日の一枚 → #오늘의한장).
- Write names of people and places in the target language's script (山田太郎 → 야마다 타로, 東京 → 도쿄).

Output format:
{ "items": [ { "i": <same i>, "sourceLangs": [<BCP 47 codes of the original>], "text": <translation> } ] }
Return one output item per input item.`;

// kyunet: feat/llm-translation - feat/image-translation
/** Connection a single LLM call uses; the image path builds it from either the text or the image* settings. */
export type KyunetLlmConnection = {
	baseUrl: string | null;
	apiKey: string | null;
	model: string | null;
	extraParams: Record<string, unknown>;
	structuredOutput: boolean;
	timeoutMs: number;
	maxConcurrency: number;
	maxTokensParam: KyunetMaxTokensParam;
	/** already resolved: the admin's value or the default; `{targetLang}` is still unreplaced */
	systemPrompt: string;
	/** which concurrency counter the call takes: the image path shares the text counter when it shares the server */
	semaphoreScope: 'text' | 'image';
};

// Kept short for small vision models, which drop rules from long lists. Measured on samples: the multilingual-sign
// rule holds only as its own bullet, and leaving out sender names holds only next to "what a reader needs".
export const DEFAULT_IMAGE_SYSTEM_PROMPT = `Translate the text in the image into {targetLang}. Reply with JSON only.

- Read the whole image first, and translate so it reads naturally as a whole, in the original's tone.
- Follow the image's reading order. Write each block of text (a speech bubble, a message, a line of a sign) as one line, joining the line breaks inside it.
- Leave an empty line between blocks from different speakers.
- Translate only what a reader needs to follow the content: leave out interface text (sender names, times, buttons).
- Text already in {targetLang} is not repeated: keep only the {targetLang} line and drop the lines that say the same in other languages.
- No original text, no explanations. If there is no readable text, return an empty text.

Output format:
{ "sourceLangs": [<BCP 47 codes of the original text>], "text": <translation> }`;

/** The whole prompt (output section included) is admin-editable; `{targetLang}` is replaced with the request's target language. */
export function buildSystemPrompt(setting: MiKyunetTranslationSetting, targetLang: string): string {
	return (setting.systemPrompt ?? DEFAULT_SYSTEM_PROMPT).replaceAll('{targetLang}', targetLang);
}

const RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'translation',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: false,
			required: ['items'],
			properties: {
				items: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						// no "needsTranslation" flag: measured against gemma-4, a flag emitted before the text made the model
						// commit to "no translation" early and then return the source verbatim or half-translated; the server
						// decides from the text alone (empty or equal to the source = nothing to translate)
						required: ['i', 'sourceLangs', 'text'],
						properties: {
							i: { type: 'integer' },
							sourceLangs: { type: 'array', items: { type: 'string' } },
							text: { type: 'string' },
						},
					},
				},
			},
		},
	},
} as const;

export function buildRequestBody(setting: MiKyunetTranslationSetting, targetLang: string, items: LlmInputItem[]): Record<string, unknown> {
	const totalChars = items.reduce((sum, item) => sum + item.text.length, 0);
	const body: Record<string, unknown> = {
		model: setting.model,
		messages: [
			{ role: 'system', content: buildSystemPrompt(setting, targetLang) },
			{ role: 'user', content: JSON.stringify({ targetLang, items }) },
		],
		[setting.maxTokensParam]: Math.min(Math.ceil(totalChars * 3) + 200, MAX_COMPLETION_TOKENS_CAP),
	};
	if (setting.structuredOutput) body.response_format = RESPONSE_FORMAT;
	// spec 5.3: extraParams win over server values; only `messages` is protected
	const { messages: _ignored, ...extra } = setting.extraParams ?? {};
	return { ...body, ...extra };
}

function stripCodeFence(content: string): string {
	const trimmed = content.trim();
	const match = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed);
	return match ? match[1] : trimmed;
}

// kyunet: feat/llm-translation - feat/image-translation
// shared by the text and image parsers: first choice, not cut by the token limit, JSON content
function parseChoiceJson(json: unknown): unknown {
	const choice = (json as { choices?: unknown[] } | null)?.choices?.[0] as { finish_reason?: string; message?: { content?: unknown } } | undefined;
	if (choice == null) throw new KyunetLlmError('no_choice', 'response has no choices');
	if (choice.finish_reason === 'length') throw new KyunetLlmError('length', 'completion was cut by the token limit');
	const content = choice.message?.content;
	if (typeof content !== 'string') throw new KyunetLlmError('invalid_json', 'message.content is not a string');

	try {
		return JSON.parse(stripCodeFence(content));
	} catch {
		throw new KyunetLlmError('invalid_json', 'message.content is not JSON');
	}
}

// the model sometimes repeats a code (["en","en"]); keep the first occurrence, order preserved
function dedupeLangs(langs: string[]): string[] {
	return [...new Set(langs.map(x => x.trim()).filter(x => x !== ''))];
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(x => typeof x === 'string');
}

export function parseLlmResponse(json: unknown, expectedIndices: number[]): LlmOutputItem[] {
	// kyunet: feat/llm-translation - feat/image-translation
	const parsed = parseChoiceJson(json) as { items?: unknown } | null;

	const items = parsed?.items;
	if (!Array.isArray(items) || items.length !== expectedIndices.length) {
		throw new KyunetLlmError('count_mismatch', `expected ${expectedIndices.length} items`);
	}
	const out: LlmOutputItem[] = [];
	for (const raw of items as Record<string, unknown>[]) {
		if (
			typeof raw?.i !== 'number'
			// kyunet: feat/llm-translation - feat/image-translation
			|| !isStringArray(raw.sourceLangs)
			|| typeof raw.text !== 'string'
		) {
			throw new KyunetLlmError('invalid_item', 'item is missing i / sourceLangs / text');
		}
		out.push({ i: raw.i, sourceLangs: dedupeLangs(raw.sourceLangs), text: raw.text });
	}
	const seen = new Set(out.map(x => x.i));
	if (seen.size !== expectedIndices.length || !expectedIndices.every(i => seen.has(i))) {
		throw new KyunetLlmError('count_mismatch', 'index set does not match the request');
	}
	return out.sort((a, b) => a.i - b.i);
}

// kyunet: feat/llm-translation - feat/image-translation
export type LlmImageInput = { mime: string; base64: string };
export type LlmImageOutput = { sourceLangs: string[]; text: string };

/** Fixed budget: the measured long manga page needed ~860 completion tokens. */
export const IMAGE_MAX_COMPLETION_TOKENS = 4096;

const IMAGE_RESPONSE_FORMAT = {
	type: 'json_schema',
	json_schema: {
		name: 'image_translation',
		strict: true,
		schema: {
			type: 'object',
			additionalProperties: false,
			required: ['sourceLangs', 'text'],
			properties: {
				sourceLangs: { type: 'array', items: { type: 'string' } },
				text: { type: 'string' },
			},
		},
	},
} as const;

export function buildImageRequestBody(conn: KyunetLlmConnection, targetLang: string, image: LlmImageInput): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: conn.model,
		messages: [
			{ role: 'system', content: conn.systemPrompt.replaceAll('{targetLang}', targetLang) },
			{
				role: 'user',
				content: [
					{ type: 'text', text: `Target language: ${targetLang}` },
					{ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } },
				],
			},
		],
		[conn.maxTokensParam]: Math.min(IMAGE_MAX_COMPLETION_TOKENS, MAX_COMPLETION_TOKENS_CAP),
	};
	if (conn.structuredOutput) body.response_format = IMAGE_RESPONSE_FORMAT;
	const { messages: _ignored, ...extra } = conn.extraParams ?? {};
	return { ...body, ...extra };
}

export function parseImageResponse(json: unknown): LlmImageOutput {
	const parsed = parseChoiceJson(json) as { sourceLangs?: unknown; text?: unknown } | null;
	if (!isStringArray(parsed?.sourceLangs) || typeof parsed.text !== 'string') {
		throw new KyunetLlmError('invalid_item', 'response is missing sourceLangs / text');
	}
	return { sourceLangs: dedupeLangs(parsed.sourceLangs), text: parsed.text };
}

const ERROR_BODY_MAX_CHARS = 500;

@Injectable()
export class KyunetTranslationLlmClient {
	constructor(
		private httpRequestService: HttpRequestService,
	) {
	}

	@bindThis
	public async complete(setting: MiKyunetTranslationSetting, targetLang: string, items: LlmInputItem[]): Promise<{ items: LlmOutputItem[]; raw: unknown; latencyMs: number }> {
		// kyunet: feat/llm-translation - feat/image-translation
		const { raw, latencyMs } = await this.post(setting, buildRequestBody(setting, targetLang, items));
		const parsed = parseLlmResponse(raw, items.map(x => x.i));
		return { items: parsed, raw, latencyMs };
	}

	// kyunet: feat/llm-translation - feat/image-translation
	@bindThis
	public async completeImage(conn: KyunetLlmConnection, targetLang: string, image: LlmImageInput): Promise<{ result: LlmImageOutput; raw: unknown; latencyMs: number }> {
		const { raw, latencyMs } = await this.post(conn, buildImageRequestBody(conn, targetLang, image));
		return { result: parseImageResponse(raw), raw, latencyMs };
	}

	// kyunet: feat/llm-translation - feat/image-translation
	private async post(conn: Pick<KyunetLlmConnection, 'baseUrl' | 'apiKey' | 'timeoutMs'>, body: Record<string, unknown>): Promise<{ raw: unknown; latencyMs: number }> {
		if (conn.baseUrl == null) throw new KyunetLlmError('http', 'baseUrl is not configured');
		const url = `${conn.baseUrl.replace(/\/+$/, '')}/chat/completions`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
		if (conn.apiKey != null && conn.apiKey !== '') headers['Authorization'] = `Bearer ${conn.apiKey}`;

		const started = Date.now();
		let raw: unknown;
		try {
			const res = await this.httpRequestService.send(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				timeout: conn.timeoutMs,
				isLocalAddressAllowed: true,
			}, { throwErrorWhenResponseNotOk: false, validators: [] });
			if (!res.ok) {
				// keep the provider's error body: it is usually the only hint (wrong model, bad key, bad param)
				const snippet = (await res.text().catch(() => '')).slice(0, ERROR_BODY_MAX_CHARS);
				throw new KyunetLlmError('http', `${res.status} ${res.statusText}: ${snippet}`);
			}
			raw = await res.json();
		} catch (err) {
			if (err instanceof KyunetLlmError) throw err;
			const aborted = err instanceof Error && err.name === 'AbortError';
			throw new KyunetLlmError(aborted ? 'timeout' : 'http', err instanceof Error ? err.message : String(err));
		}
		return { raw, latencyMs: Date.now() - started };
	}
}
