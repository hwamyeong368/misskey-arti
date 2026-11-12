/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// arti: DeepL backend for the kyunet translation feature. Same contract as KyunetTranslationLlmClient.complete(),
// so notes, user names and profile texts can be translated by DeepL with the instance-wide DeepL key
// (meta.deeplAuthKey / meta.deeplIsPro). The key must never appear in logs or error messages.

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/Meta.js';
import type { MiKyunetTranslationSetting } from '@/models/KyunetTranslationSetting.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { bindThis } from '@/decorators.js';
import { KyunetLlmError } from '@/core/KyunetTranslationLlmClient.js';
import type { LlmInputItem, LlmOutputItem } from '@/core/KyunetTranslationLlmClient.js';

const DEEPL_FREE_ENDPOINT = 'https://api-free.deepl.com/v2/translate';
const DEEPL_PRO_ENDPOINT = 'https://api.deepl.com/v2/translate';
/** DeepL accepts at most 50 texts per request. */
export const DEEPL_MAX_TEXTS_PER_REQUEST = 50;
const ERROR_BODY_MAX_CHARS = 500;

const LANG_MAP: Record<string, string> = {
	'ko': 'KO', 'ko-kr': 'KO',
	'ja': 'JA', 'ja-jp': 'JA',
	'en': 'EN-US', 'en-us': 'EN-US', 'en-gb': 'EN-GB',
	'zh': 'ZH-HANS', 'zh-cn': 'ZH-HANS', 'zh-hans': 'ZH-HANS',
	'zh-tw': 'ZH-HANT', 'zh-hant': 'ZH-HANT',
	'pt': 'PT-BR', 'pt-br': 'PT-BR', 'pt-pt': 'PT-PT',
};

/** BCP 47 tag of the UI language → DeepL `target_lang`. */
export function toDeeplTargetLang(targetLang: string): string {
	const lower = targetLang.toLowerCase();
	return LANG_MAP[lower] ?? lower.split('-')[0].toUpperCase();
}

// Parts DeepL must not touch. Order matters: code first, then URLs (they may contain '@', '#', ':').
const PROTECTED_PATTERN = new RegExp([
	'```[\\s\\S]*?```', // code block
	'`[^`\\n]+`', // inline code
	'https?:\\/\\/[^\\s<>]+', // URL
	'\\$\\[[a-zA-Z0-9_.,=\\-]+\\s?', // MFM function opener: $[name.arg=1 (its content stays translatable)
	'@[a-zA-Z0-9_]+(?:@[a-zA-Z0-9_.\\-]+)?', // mention
	'#[^\\s#<>.,!?\'"()\\[\\]]+', // hashtag
	':[a-zA-Z0-9_+\\-]+(?:@[a-zA-Z0-9_.\\-]+)?:', // custom emoji
].join('|'), 'g');

function escapeXml(text: string): string {
	return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function unescapeXml(text: string): string {
	return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', '\'').replaceAll('&amp;', '&');
}

/** Replaces untranslatable parts with `<x id="N"/>` and XML-escapes the rest (the request uses tag_handling=xml). */
export function protectForDeepl(text: string): { text: string; tokens: string[] } {
	const tokens: string[] = [];
	let out = '';
	let last = 0;
	for (const match of text.matchAll(PROTECTED_PATTERN)) {
		out += escapeXml(text.slice(last, match.index));
		out += `<x id="${tokens.length}"/>`;
		tokens.push(match[0]);
		last = match.index + match[0].length;
	}
	out += escapeXml(text.slice(last));
	return { text: out, tokens };
}

/** Inverse of protectForDeepl. Unknown placeholder ids are dropped. */
export function restoreFromDeepl(text: string, tokens: string[]): string {
	const placeholder = /<x id="(\d+)"\s*(?:\/>|><\/x>)/g;
	let out = '';
	let last = 0;
	for (const match of text.matchAll(placeholder)) {
		out += unescapeXml(text.slice(last, match.index));
		out += tokens[Number(match[1])] ?? '';
		last = match.index + match[0].length;
	}
	out += unescapeXml(text.slice(last));
	return out;
}

type DeeplTranslation = { detected_source_language?: unknown; text?: unknown };

@Injectable()
export class KyunetTranslationDeeplClient {
	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		private httpRequestService: HttpRequestService,
	) {
	}

	@bindThis
	public async complete(setting: MiKyunetTranslationSetting, targetLang: string, items: LlmInputItem[]): Promise<{ items: LlmOutputItem[]; raw: unknown; latencyMs: number }> {
		const authKey = this.meta.deeplAuthKey;
		if (authKey == null || authKey === '') throw new KyunetLlmError('http', 'DeepL auth key is not configured');
		const url = this.meta.deeplIsPro ? DEEPL_PRO_ENDPOINT : DEEPL_FREE_ENDPOINT;
		const deeplTarget = toDeeplTargetLang(targetLang);
		const targetPrimary = deeplTarget.split('-')[0].toLowerCase();

		const started = Date.now();
		const output: LlmOutputItem[] = [];
		const raws: unknown[] = [];
		for (let offset = 0; offset < items.length; offset += DEEPL_MAX_TEXTS_PER_REQUEST) {
			const chunk = items.slice(offset, offset + DEEPL_MAX_TEXTS_PER_REQUEST);
			const prepared = chunk.map(item => protectForDeepl(item.text));
			const raw = await this.request(url, authKey, setting.timeoutMs, {
				text: prepared.map(p => p.text),
				target_lang: deeplTarget,
				tag_handling: 'xml',
				ignore_tags: ['x'],
				preserve_formatting: true,
			});
			raws.push(raw);

			const translations = (raw as { translations?: unknown } | null)?.translations;
			if (!Array.isArray(translations) || translations.length !== chunk.length) {
				throw new KyunetLlmError('count_mismatch', 'DeepL returned a different number of translations');
			}
			(translations as DeeplTranslation[]).forEach((t, k) => {
				if (t == null || typeof t.text !== 'string') throw new KyunetLlmError('invalid_item', 'DeepL returned an item without text');
				const detected = typeof t.detected_source_language === 'string' ? t.detected_source_language.toLowerCase() : '';
				const sameLang = detected !== '' && detected.split('-')[0] === targetPrimary;
				output.push({
					i: chunk[k].i,
					sourceLangs: detected !== '' ? [detected] : [],
					text: sameLang ? '' : restoreFromDeepl(t.text, prepared[k].tokens),
				});
			});
		}
		return { items: output, raw: raws.length === 1 ? raws[0] : raws, latencyMs: Date.now() - started };
	}

	/**
	 * Characters used / allowed in the current DeepL billing period (GET /v2/usage).
	 * Returns null when no key is configured or the request fails. The key never leaves this method.
	 */
	@bindThis
	public async usage(timeoutMs = 5000): Promise<{ count: number; limit: number } | null> {
		const authKey = this.meta.deeplAuthKey;
		if (authKey == null || authKey === '') return null;
		const url = (this.meta.deeplIsPro ? DEEPL_PRO_ENDPOINT : DEEPL_FREE_ENDPOINT).replace(/\/translate$/, '/usage');
		try {
			const res = await this.httpRequestService.send(url, {
				method: 'GET',
				headers: {
					Accept: 'application/json',
					Authorization: `DeepL-Auth-Key ${authKey}`,
				},
				timeout: timeoutMs,
			}, { throwErrorWhenResponseNotOk: false, validators: [] });
			if (!res.ok) return null;
			const json = await res.json() as { character_count?: unknown; character_limit?: unknown } | null;
			const count = json?.character_count;
			const limit = json?.character_limit;
			if (typeof count !== 'number' || typeof limit !== 'number') return null;
			return { count, limit };
		} catch {
			return null;
		}
	}

	private async request(url: string, authKey: string, timeoutMs: number, body: Record<string, unknown>): Promise<unknown> {
		try {
			const res = await this.httpRequestService.send(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
					Authorization: `DeepL-Auth-Key ${authKey}`,
				},
				body: JSON.stringify(body),
				timeout: timeoutMs,
			}, { throwErrorWhenResponseNotOk: false, validators: [] });
			if (!res.ok) {
				const snippet = (await res.text().catch(() => '')).slice(0, ERROR_BODY_MAX_CHARS);
				let hint = res.statusText;
				if (res.status === 456) hint = 'DeepL quota exceeded';
				else if (res.status === 403) hint = 'DeepL rejected the auth key (check the key and the Pro switch)';
				else if (res.status === 429) hint = 'DeepL: too many requests';
				// defensive: an error body should never echo the key, but make sure it cannot reach logs
				throw new KyunetLlmError('http', `${res.status} ${hint}: ${snippet}`.replaceAll(authKey, '***'));
			}
			return await res.json();
		} catch (err) {
			if (err instanceof KyunetLlmError) throw err;
			const aborted = err instanceof Error && err.name === 'AbortError';
			const message = (err instanceof Error ? err.message : String(err)).replaceAll(authKey, '***');
			throw new KyunetLlmError(aborted ? 'timeout' : 'http', message);
		}
	}
}
