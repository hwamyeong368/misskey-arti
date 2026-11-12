/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: tests for the fork-only translation request queue

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { KyunetTranslationQueue, kyunetTranslationKey } from '@/utility/kyunet-translation-queue.js';
import type { KyunetTranslationRef, KyunetTranslationResult } from '@/utility/kyunet-translation-queue.js';

const ok = (text: string | null): KyunetTranslationResult => ({ status: 'ok', text, sourceLangs: ['ja'] });
const failed: KyunetTranslationResult = { status: 'failed', text: null, sourceLangs: [] };

describe('kyunetTranslationKey', () => {
	test('includes type, id, index and target language', () => {
		expect(kyunetTranslationKey({ type: 'note', id: 'n1' }, 'ko-KR')).toBe('note:n1::ko-KR');
		expect(kyunetTranslationKey({ type: 'user_field_value', id: 'u1', index: 2 }, 'ko')).toBe('user_field_value:u1:2:ko');
	});
});

describe('KyunetTranslationQueue', () => {
	let send: ReturnType<typeof vi.fn>;
	let queue: KyunetTranslationQueue;

	beforeEach(() => {
		vi.useFakeTimers();
		send = vi.fn(async (items: KyunetTranslationRef[]) => items.map(it => ok(`[t]${it.id}`)));
		queue = new KyunetTranslationQueue(send as any, { debounceMs: 200, maxItems: 50, failedTtlMs: 60000, rateLimitedTtlMs: 15000, minIntervalMs: 1000 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('debounces requests into one call and fills every ref in order', async () => {
		const a = queue.request({ type: 'note', id: 'a' }, 'ko');
		const b = queue.request({ type: 'user_name', id: 'b' }, 'ko');
		expect(a.value).toBeNull();
		expect(send).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(199);
		expect(send).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toEqual([{ type: 'note', id: 'a' }, { type: 'user_name', id: 'b' }]);
		expect(send.mock.calls[0][1]).toBe('ko');
		expect(a.value).toEqual(ok('[t]a'));
		expect(b.value).toEqual(ok('[t]b'));
	});

	test('the same key is requested once and shares the ref', async () => {
		const a1 = queue.request({ type: 'note', id: 'a' }, 'ko');
		const a2 = queue.request({ type: 'note', id: 'a' }, 'ko');
		expect(a1).toBe(a2);
		await vi.advanceTimersByTimeAsync(200);
		expect(send.mock.calls[0][0]).toHaveLength(1);
		queue.request({ type: 'note', id: 'a' }, 'ko');
		await vi.advanceTimersByTimeAsync(200);
		expect(send).toHaveBeenCalledTimes(1);
	});

	test('flushes immediately at maxItems and groups by target language', async () => {
		for (let i = 0; i < 50; i++) queue.request({ type: 'note', id: `n${i}` }, 'ko');
		await vi.advanceTimersByTimeAsync(0);
		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toHaveLength(50);
		queue.request({ type: 'note', id: 'x' }, 'ko');
		queue.request({ type: 'note', id: 'y' }, 'ja');
		// the next slot is held back by the 1 s minimum interval
		await vi.advanceTimersByTimeAsync(200);
		expect(send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(800);
		expect(send).toHaveBeenCalledTimes(3);
	});

	test('failed results are not re-requested within the TTL, but are after it', async () => {
		send.mockResolvedValueOnce([failed]);
		const r = queue.request({ type: 'note', id: 'f' }, 'ko');
		await vi.advanceTimersByTimeAsync(200);
		expect(r.value).toEqual(failed);

		const again = queue.request({ type: 'note', id: 'f' }, 'ko');
		expect(again).toBe(r);
		await vi.advanceTimersByTimeAsync(200);
		expect(send).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(60000);
		queue.request({ type: 'note', id: 'f' }, 'ko');
		await vi.advanceTimersByTimeAsync(200);
		expect(send).toHaveBeenCalledTimes(2);
		expect(r.value).toEqual(ok('[t]f'));
	});

	test('a rejected send marks the whole batch failed', async () => {
		send.mockRejectedValueOnce(new Error('network'));
		const r = queue.request({ type: 'note', id: 'a' }, 'ko');
		await vi.advanceTimersByTimeAsync(200);
		expect(r.value).toEqual(failed);
	});

	test('translateNow bypasses the queue, sends force, and overwrites the cached ref', async () => {
		const cached = queue.request({ type: 'note', id: 'a' }, 'ko');
		await vi.advanceTimersByTimeAsync(200);
		expect(cached.value).toEqual(ok('[t]a'));

		send.mockResolvedValueOnce([ok('forced')]);
		const res = await queue.translateNow({ type: 'note', id: 'a' }, 'ko');
		expect(send).toHaveBeenLastCalledWith([{ type: 'note', id: 'a' }], 'ko', true);
		expect(res).toEqual(ok('forced'));
		expect(cached.value).toEqual(ok('forced'));
	});

	test('a failed translateNow keeps an ok cached result but still reports the failure', async () => {
		const cached = queue.request({ type: 'note', id: 'a' }, 'ko');
		await vi.advanceTimersByTimeAsync(200);
		expect(cached.value).toEqual(ok('[t]a'));

		send.mockRejectedValueOnce(new Error('network'));
		const res = await queue.translateNow({ type: 'note', id: 'a' }, 'ko');
		expect(res).toEqual(failed);
		expect(cached.value).toEqual(ok('[t]a'));
		expect(queue.peek({ type: 'note', id: 'a' }, 'ko')).toEqual(ok('[t]a'));
	});

	test('translateManyNow sends every ref in one forced call and fills each cached ref positionally', async () => {
		const a = queue.request({ type: 'user_description', id: 'u' }, 'ko');
		await vi.advanceTimersByTimeAsync(200);
		expect(a.value).toEqual(ok('[t]u'));

		send.mockResolvedValueOnce([ok('bio'), failed, ok(null)]);
		const refs: KyunetTranslationRef[] = [
			{ type: 'user_description', id: 'u' },
			{ type: 'user_field_name', id: 'u', index: 0 },
			{ type: 'user_field_value', id: 'u', index: 0 },
		];
		const res = await queue.translateManyNow(refs, 'ko');
		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenLastCalledWith(refs, 'ko', true);
		expect(res).toEqual([ok('bio'), failed, ok(null)]);
		expect(a.value).toEqual(ok('bio'));
		expect(queue.peek(refs[1], 'ko')).toEqual(failed);
		expect(queue.peek(refs[2], 'ko')).toEqual(ok(null));

		// a later request() for the failed one is retried only after the failed TTL
		queue.request(refs[1], 'ko');
		await vi.advanceTimersByTimeAsync(200);
		expect(send).toHaveBeenCalledTimes(2);
	});

	test('translateManyNow with an empty list sends nothing', async () => {
		expect(await queue.translateManyNow([], 'ko')).toEqual([]);
		expect(send).not.toHaveBeenCalled();
	});

	test('peek returns null for unknown keys and the cached value otherwise, without sending', async () => {
		expect(queue.peek({ type: 'note', id: 'nope' }, 'ko')).toBeNull();
		await vi.advanceTimersByTimeAsync(5000);
		expect(send).not.toHaveBeenCalled();

		queue.request({ type: 'note', id: 'a' }, 'ko');
		expect(queue.peek({ type: 'note', id: 'a' }, 'ko')).toBeNull();
		await vi.advanceTimersByTimeAsync(200);
		expect(queue.peek({ type: 'note', id: 'a' }, 'ko')).toEqual(ok('[t]a'));
		expect(queue.peek({ type: 'note', id: 'a' }, 'ja')).toBeNull();
		expect(send).toHaveBeenCalledTimes(1);
	});

	test('flushes closer than the minimum interval collapse into one send per second', async () => {
		queue.request({ type: 'note', id: 'a' }, 'ko');
		await vi.advanceTimersByTimeAsync(200); // first flush at t=200
		expect(send).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(200);
		queue.request({ type: 'note', id: 'b' }, 'ko'); // would flush at t=600
		await vi.advanceTimersByTimeAsync(200);
		queue.request({ type: 'note', id: 'c' }, 'ko'); // would flush at t=800
		await vi.advanceTimersByTimeAsync(599); // t=1199
		expect(send).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1); // t=1200 = previous flush + 1 s
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1][0]).toEqual([{ type: 'note', id: 'b' }, { type: 'note', id: 'c' }]);
	});

	test('entries queued while a batch is in flight are sent after it resolves', async () => {
		let resolveFirst!: (v: KyunetTranslationResult[]) => void;
		send.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
		const a = queue.request({ type: 'note', id: 'a' }, 'ko');
		await vi.advanceTimersByTimeAsync(200);
		expect(send).toHaveBeenCalledTimes(1);

		const b = queue.request({ type: 'note', id: 'b' }, 'ko');
		await vi.advanceTimersByTimeAsync(3000); // slot passes, but the language is still in flight
		expect(send).toHaveBeenCalledTimes(1);

		resolveFirst([ok('[t]a')]);
		await vi.advanceTimersByTimeAsync(0);
		expect(a.value).toEqual(ok('[t]a'));
		expect(send).toHaveBeenCalledTimes(2);
		expect(send.mock.calls[1][0]).toEqual([{ type: 'note', id: 'b' }]);
		expect(b.value).toEqual(ok('[t]b'));
	});

	test('a rate-limited send is retried after the shorter TTL', async () => {
		send.mockRejectedValueOnce({ code: 'RATE_LIMIT_EXCEEDED', id: 'd5826d14-3982-4d2e-8011-b9e9f02499ef', message: 'Rate limit exceeded.' });
		const r = queue.request({ type: 'note', id: 'a' }, 'ko');
		await vi.advanceTimersByTimeAsync(200);
		expect(r.value).toEqual(failed);

		await vi.advanceTimersByTimeAsync(14999);
		queue.request({ type: 'note', id: 'a' }, 'ko');
		await vi.advanceTimersByTimeAsync(1000);
		expect(send).toHaveBeenCalledTimes(1);

		queue.request({ type: 'note', id: 'a' }, 'ko'); // now 15 s+ after the failure
		await vi.advanceTimersByTimeAsync(200);
		expect(send).toHaveBeenCalledTimes(2);
		expect(r.value).toEqual(ok('[t]a'));
	});
});
