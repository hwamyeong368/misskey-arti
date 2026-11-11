/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { KyunetTranslationService } from '@/core/KyunetTranslationService.js';
import { KyunetLlmError } from '@/core/KyunetTranslationLlmClient.js';
import type { LlmInputItem } from '@/core/KyunetTranslationLlmClient.js';
import type { MiKyunetTranslationSetting } from '@/models/KyunetTranslationSetting.js';
import type { MiLocalUser } from '@/models/User.js';

type Complete = (setting: unknown, targetLang: string, items: LlmInputItem[]) => Promise<{ items: { i: number; needsTranslation: boolean; sourceLangs: string[]; text: string }[]; raw: unknown; latencyMs: number }>;

const translateAll = (prefix: string): Complete => async (_s, _l, items) => ({
	items: items.map(x => ({ i: x.i, needsTranslation: true, sourceLangs: ['ja'], text: `${prefix}${x.text}` })),
	raw: null,
	latencyMs: 1,
});

function setup(opts: { llm: Complete; deepl?: Complete; fallback?: boolean; provider?: 'openai' | 'deepl'; profiles: Record<string, string> }) {
	const setting = {
		enabled: true, provider: opts.provider ?? 'openai', fallbackEnabled: opts.fallback ?? false,
		baseUrl: 'http://llm', model: 'm', timeoutMs: 1000, maxConcurrency: 4, maxInputLength: 100000,
		batchMaxChars: 100000, batchMaxItems: 8, heuristicGate: false,
	} as unknown as MiKyunetTranslationSetting;
	const llm = vi.fn(opts.llm);
	const deepl = vi.fn(opts.deepl ?? translateAll('D:'));
	const inserted: unknown[] = [];
	const qb = { insert: () => qb, values: (rows: unknown[]) => { inserted.push(...rows); return qb; }, orIgnore: () => qb, orUpdate: () => qb, execute: async () => ({}) };
	const service = new KyunetTranslationService(
		{ redis: { prefix: 't' } } as never,
		{ incr: async () => 1, expire: async () => 1, decr: async () => 0, del: async () => 1, hincrby: async () => 1 } as never,
		{} as never,
		{} as never,
		{ findOneBy: async ({ userId }: { userId: string }) => ({ description: opts.profiles[userId] }) } as never,
		{ findBy: async () => [], createQueryBuilder: () => qb } as never,
		{} as never,
		{} as never,
		{
			get: () => setting,
			fallbackProvider: (s: MiKyunetTranslationSetting) => (s.fallbackEnabled ? (s.provider === 'deepl' ? 'openai' : 'deepl') : null),
		} as never,
		{ complete: llm } as never,
		{ complete: deepl } as never,
		{} as never,
		{} as never,
		{ getLogger: () => ({ warn: () => {}, info: () => {} }) } as never,
	);
	const me = { id: 'me' } as MiLocalUser;
	const run = (ids: string[]) => service.translate(ids.map(id => ({ type: 'user_description' as const, id })), 'ko-KR', me);
	return { run, llm, deepl, inserted };
}

describe('KyunetTranslationService recovery (arti)', () => {
	test('count mismatch on a batch → items retried one by one', async () => {
		const { run, llm } = setup({
			llm: async (s, l, items) => {
				if (items.length > 1) throw new KyunetLlmError('count_mismatch');
				return translateAll('L:')(s, l, items);
			},
			profiles: { a: 'こんにちは', b: 'さようなら' },
		});
		const res = await run(['a', 'b']);
		expect(res.map(r => r.text)).toEqual(['L:こんにちは', 'L:さようなら']);
		expect(llm).toHaveBeenCalledTimes(3);
	});

	test('http error → fallback provider when enabled', async () => {
		const { run, deepl, inserted } = setup({
			llm: async () => { throw new KyunetLlmError('http', '500'); },
			fallback: true,
			profiles: { a: 'こんにちは' },
		});
		const res = await run(['a']);
		expect(res[0]).toMatchObject({ status: 'ok', text: 'D:こんにちは' });
		expect(deepl).toHaveBeenCalledTimes(1);
		expect(inserted[0]).toMatchObject({ provider: 'deepl', model: 'deepl' });
	});

	test('http error without fallback → failed, nothing cached', async () => {
		const { run, deepl, inserted } = setup({
			llm: async () => { throw new KyunetLlmError('http', '500'); },
			profiles: { a: 'こんにちは' },
		});
		const res = await run(['a']);
		expect(res[0].status).toBe('failed');
		expect(deepl).not.toHaveBeenCalled();
		expect(inserted).toEqual([]);
	});

	test('long text is sent in pieces and glued back with its line breaks', async () => {
		const para = (c: string) => c.repeat(700);
		const text = `${para('あ')}\n\n${para('い')}\n\n${para('う')}`;
		const { run, llm } = setup({ llm: translateAll('L:'), profiles: { a: text } });
		const res = await run(['a']);
		const sent = llm.mock.calls.flatMap(c => c[2].map(x => x.text));
		expect(sent).toEqual([para('あ'), para('い'), para('う')]);
		expect(res[0].text).toBe(`L:${para('あ')}\n\nL:${para('い')}\n\nL:${para('う')}`);
	});

	test('pieces already in the target language stay as they are', async () => {
		const text = `${'あ'.repeat(700)}\n\n${'가'.repeat(700)}`;
		const { run } = setup({
			llm: async (_s, _l, items) => ({
				items: items.map(x => ({ i: x.i, needsTranslation: !x.text.startsWith('가'), sourceLangs: [x.text.startsWith('가') ? 'ko' : 'ja'], text: x.text.startsWith('가') ? '' : 'L' })),
				raw: null,
				latencyMs: 1,
			}),
			profiles: { a: text },
		});
		const res = await run(['a']);
		expect(res[0].text).toBe(`L\n\n${'가'.repeat(700)}`);
		expect(res[0].sourceLangs).toEqual(['ja', 'ko']);
	});
});
