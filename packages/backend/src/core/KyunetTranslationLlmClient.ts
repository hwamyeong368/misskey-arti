/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only OpenAI-compatible Chat Completions client for LLM translation (spec 5.3).
// Builds the request body, sends it through HttpRequestService and validates the JSON reply.

import { Injectable } from '@nestjs/common';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { bindThis } from '@/decorators.js';
import type { MiKyunetTranslationSetting } from '@/models/KyunetTranslationSetting.js';

export type TranslationKind = 'note' | 'user_name' | 'user_description' | 'user_field_name' | 'user_field_value';
export type LlmInputItem = { i: number; kind: TranslationKind; text: string };
export type LlmOutputItem = { i: number; needsTranslation: boolean; sourceLangs: string[]; text: string };

export type KyunetLlmErrorReason = 'http' | 'timeout' | 'length' | 'invalid_json' | 'count_mismatch' | 'invalid_item' | 'no_choice';

export class KyunetLlmError extends Error {
	constructor(public readonly reason: KyunetLlmErrorReason, message?: string) {
		super(message ?? reason);
		this.name = 'KyunetLlmError';
	}
}

export const MAX_COMPLETION_TOKENS_CAP = 8192;

export const DEFAULT_SYSTEM_PROMPT = `You are a translation engine for a Misskey (fediverse) server. You receive a JSON object with a target language and a list of items. Translate each item into the target language and reply with a JSON object of the same shape. Reply with JSON only.

General rules
- Each item is an independent text from a different author or context. Translate every item on its own; never carry names, topics, tone, or wording from one item into another, and never merge or swap items.
- Keep these verbatim, never translate or alter them: URLs, @mentions, #hashtags, custom emoji shortcodes like :name:, code blocks and inline code, and MFM syntax such as $[...], <center>, <small>, **bold**, and the line "-----".
- Parts that are already written in the target language stay verbatim.
- Proper nouns (people, places, works, brands) must end up readable to the target-language reader: use the established target-language name when one exists, otherwise a phonetic rendering in the target script. Never leave a foreign-script name as-is just because it is a name.
- If the same content appears in several languages, translate it once; do not repeat an existing target-language version.
- Preserve line breaks and the overall structure.
- Do not add explanations, notes, or quotation marks around the result.

Per-kind rules
- kind "note": the body of a post. Translate naturally, keeping the tone (casual, formal, playful).
- kind "user_name": a display name. Render personal names in the target language's usual form for foreign names (transliterate: 山田太郎 → 야마다 타로 for Korean) and translate descriptive parts such as a role or status written after the name. Handles and emoji shortcodes stay in place.
- kind "user_description": a profile bio. Translate naturally; keep lists and line structure.
- kind "user_field_name": the label of a profile field (for example "Location", "Pronouns", "Website"). Translate as a short label.
- kind "user_field_value": a short profile field value such as a location, pronouns, or a link label. Place names use the target language's usual name (東京 → 도쿄 for Korean); pronouns are translated to the target language's equivalent. Links stay verbatim.

Output
- For each input item return { "i": <same index>, "needsTranslation": <boolean>, "sourceLangs": [<BCP 47 codes, dominant first>], "text": <string> }.
- Set needsTranslation to false and text to "" only when the item is already readable as-is by a reader of the target language: it is written in the target language, or it is only code, links, emoji, symbols, or numbers. A proper noun written in a foreign script is not readable as-is; render it in the target language.
- Return every item exactly once, in the same order, with the same indices.`;

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
						required: ['i', 'needsTranslation', 'sourceLangs', 'text'],
						properties: {
							i: { type: 'integer' },
							needsTranslation: { type: 'boolean' },
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

export function parseLlmResponse(json: unknown, expectedIndices: number[]): LlmOutputItem[] {
	const choice = (json as { choices?: unknown[] } | null)?.choices?.[0] as { finish_reason?: string; message?: { content?: unknown } } | undefined;
	if (choice == null) throw new KyunetLlmError('no_choice', 'response has no choices');
	if (choice.finish_reason === 'length') throw new KyunetLlmError('length', 'completion was cut by the token limit');
	const content = choice.message?.content;
	if (typeof content !== 'string') throw new KyunetLlmError('invalid_json', 'message.content is not a string');

	let parsed: { items?: unknown };
	try {
		parsed = JSON.parse(stripCodeFence(content));
	} catch {
		throw new KyunetLlmError('invalid_json', 'message.content is not JSON');
	}

	const items = parsed?.items;
	if (!Array.isArray(items) || items.length !== expectedIndices.length) {
		throw new KyunetLlmError('count_mismatch', `expected ${expectedIndices.length} items`);
	}
	const out: LlmOutputItem[] = [];
	for (const raw of items as Record<string, unknown>[]) {
		if (
			typeof raw?.i !== 'number'
			|| typeof raw.needsTranslation !== 'boolean'
			|| !Array.isArray(raw.sourceLangs) || !raw.sourceLangs.every(x => typeof x === 'string')
			|| typeof raw.text !== 'string'
		) {
			throw new KyunetLlmError('invalid_item', 'item is missing i / needsTranslation / sourceLangs / text');
		}
		out.push({ i: raw.i, needsTranslation: raw.needsTranslation, sourceLangs: raw.sourceLangs as string[], text: raw.text });
	}
	const seen = new Set(out.map(x => x.i));
	if (seen.size !== expectedIndices.length || !expectedIndices.every(i => seen.has(i))) {
		throw new KyunetLlmError('count_mismatch', 'index set does not match the request');
	}
	return out.sort((a, b) => a.i - b.i);
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
		if (setting.baseUrl == null) throw new KyunetLlmError('http', 'baseUrl is not configured');
		const url = `${setting.baseUrl.replace(/\/+$/, '')}/chat/completions`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		};
		if (setting.apiKey != null && setting.apiKey !== '') headers['Authorization'] = `Bearer ${setting.apiKey}`;

		const started = Date.now();
		let raw: unknown;
		try {
			const res = await this.httpRequestService.send(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(buildRequestBody(setting, targetLang, items)),
				timeout: setting.timeoutMs,
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
		const parsed = parseLlmResponse(raw, items.map(x => x.i));
		return { items: parsed, raw, latencyMs: Date.now() - started };
	}
}
