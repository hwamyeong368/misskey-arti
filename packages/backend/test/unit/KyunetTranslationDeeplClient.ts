/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { KyunetTranslationDeeplClient, protectForDeepl, restoreFromDeepl, toDeeplTargetLang } from '@/core/KyunetTranslationDeeplClient.js';
import { KyunetLlmError } from '@/core/KyunetTranslationLlmClient.js';
import type { LlmInputItem } from '@/core/KyunetTranslationLlmClient.js';
import type { MiKyunetTranslationSetting } from '@/models/KyunetTranslationSetting.js';
import type { MiMeta } from '@/models/Meta.js';
import type { HttpRequestService } from '@/core/HttpRequestService.js';

const KEY = 'secret-key:fx';
const setting = { timeoutMs: 5000 } as MiKyunetTranslationSetting;

type Reply = { ok: boolean; status: number; statusText: string; json: () => Promise<unknown>; text: () => Promise<string> };

function okReply(translations: { text: string; detected_source_language: string }[]): Reply {
	return { ok: true, status: 200, statusText: 'OK', json: async () => ({ translations }), text: async () => '' };
}

function setup(send: (url: string, init: { headers: Record<string, string>; body: string }) => Promise<Reply>, meta: Partial<MiMeta> = {}) {
	const sendMock = vi.fn(send);
	const client = new KyunetTranslationDeeplClient(
		{ deeplAuthKey: KEY, deeplIsPro: false, ...meta } as MiMeta,
		{ send: sendMock } as unknown as HttpRequestService,
	);
	return { client, sendMock };
}

/** echoes every text back as a "translation" from Japanese */
const echo = async (_url: string, init: { body: string }) => okReply((JSON.parse(init.body).text as string[]).map(text => ({ text, detected_source_language: 'JA' })));

describe('KyunetTranslationDeeplClient', () => {
	test('language code mapping', () => {
		expect(toDeeplTargetLang('ko-KR')).toBe('KO');
		expect(toDeeplTargetLang('ja')).toBe('JA');
		expect(toDeeplTargetLang('en')).toBe('EN-US');
		expect(toDeeplTargetLang('en-GB')).toBe('EN-GB');
		expect(toDeeplTargetLang('zh-CN')).toBe('ZH-HANS');
		expect(toDeeplTargetLang('zh-TW')).toBe('ZH-HANT');
		expect(toDeeplTargetLang('pt-PT')).toBe('PT-PT');
		expect(toDeeplTargetLang('de-DE')).toBe('DE');
	});

	test('protected parts survive a round trip', () => {
		const source = 'やあ @alice@example.com :blobcat: #タグ https://example.com/a?b=1&c=2 `x < y` $[shake A & B] <center>';
		const { text, tokens } = protectForDeepl(source);
		expect(tokens).toEqual(['@alice@example.com', ':blobcat:', '#タグ', 'https://example.com/a?b=1&c=2', '`x < y`', '$[shake ']);
		expect(text).not.toContain('@alice');
		expect(text).toContain('A &amp; B');
		expect(text).toContain('&lt;center&gt;');
		expect(restoreFromDeepl(text, tokens)).toBe(source);
	});

	test('translates and restores placeholders', async () => {
		const { client, sendMock } = setup(async (_url, init) => {
			const texts = JSON.parse(init.body).text as string[];
			return okReply(texts.map(t => ({ text: `번역 ${t}`, detected_source_language: 'JA' })));
		});
		const res = await client.complete(setting, 'ko-KR', [{ i: 0, kind: 'note', text: 'こんにちは @bob :wave:' }]);
		expect(res.items).toEqual([{ i: 0, sourceLangs: ['ja'], text: '번역 こんにちは @bob :wave:' }]);
		const [url, init] = sendMock.mock.calls[0];
		expect(url).toBe('https://api-free.deepl.com/v2/translate');
		expect(init.headers.Authorization).toBe(`DeepL-Auth-Key ${KEY}`);
		const body = JSON.parse(init.body);
		expect(body.target_lang).toBe('KO');
		expect(body.tag_handling).toBe('xml');
		expect(body.ignore_tags).toEqual(['x']);
	});

	test('uses the pro endpoint when deeplIsPro', async () => {
		const { client, sendMock } = setup(echo, { deeplIsPro: true });
		await client.complete(setting, 'ko', [{ i: 0, kind: 'note', text: 'a' }]);
		expect(sendMock.mock.calls[0][0]).toBe('https://api.deepl.com/v2/translate');
	});

	test('same language means nothing to translate', async () => {
		const { client } = setup(async () => okReply([{ text: '안녕', detected_source_language: 'KO' }]));
		const res = await client.complete(setting, 'ko-KR', [{ i: 3, kind: 'user_name', text: '안녕' }]);
		expect(res.items).toEqual([{ i: 3, sourceLangs: ['ko'], text: '' }]);
	});

	test('splits more than 50 items into several requests', async () => {
		const { client, sendMock } = setup(echo);
		const items: LlmInputItem[] = Array.from({ length: 120 }, (_, i) => ({ i, kind: 'note', text: `t${i}` }));
		const res = await client.complete(setting, 'ko', items);
		expect(sendMock).toHaveBeenCalledTimes(3);
		expect(sendMock.mock.calls.map(c => JSON.parse(c[1].body).text.length)).toEqual([50, 50, 20]);
		expect(res.items.map(x => x.i)).toEqual(items.map(x => x.i));
		expect(res.items[119].text).toBe('t119');
	});

	test('quota error is readable and never contains the key', async () => {
		const { client } = setup(async () => ({ ok: false, status: 456, statusText: '', json: async () => ({}), text: async () => `quota for ${KEY}` }));
		const err = await client.complete(setting, 'ko', [{ i: 0, kind: 'note', text: 'a' }]).catch(e => e);
		expect(err).toBeInstanceOf(KyunetLlmError);
		expect(err.reason).toBe('http');
		expect(err.message).toContain('DeepL quota exceeded');
		expect(err.message).not.toContain(KEY);
	});

	test('timeout and missing key', async () => {
		const { client } = setup(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
		const err = await client.complete(setting, 'ko', [{ i: 0, kind: 'note', text: 'a' }]).catch(e => e);
		expect(err.reason).toBe('timeout');

		const noKey = setup(echo, { deeplAuthKey: null });
		const err2 = await noKey.client.complete(setting, 'ko', [{ i: 0, kind: 'note', text: 'a' }]).catch(e => e);
		expect(err2).toBeInstanceOf(KyunetLlmError);
		expect(noKey.sendMock).not.toHaveBeenCalled();
	});
});
