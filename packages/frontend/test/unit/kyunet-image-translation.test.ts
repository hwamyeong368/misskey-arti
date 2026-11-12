/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: feat/llm-translation - feat/image-translation

import { describe, expect, test, vi } from 'vitest';

const misskeyApi = vi.fn();
vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: (...args: unknown[]) => misskeyApi(...args),
}));
vi.mock('@/i.js', () => ({
	$i: { id: 'me', policies: { canUseTranslator: true } },
}));
vi.mock('@/instance.js', () => ({
	instance: { llmTranslatorAvailable: true, llmImageTranslatorAvailable: true },
}));
vi.mock('@/composables/use-kyunet-translation.js', () => ({
	kyunetTargetLang: () => 'ko-KR',
}));

const { requestImageTranslation, isKyunetImageTranslationAvailable, createKyunetImageTranslationContext } = await import('@/composables/use-kyunet-image-translation.js');

describe('requestImageTranslation', () => {
	test('is available with the policy and the meta flag', () => {
		expect(isKyunetImageTranslationAvailable()).toBe(true);
	});

	test('the same image and language is requested once and shares one state', async () => {
		misskeyApi.mockResolvedValueOnce({ status: 'ok', text: '번역', sourceLangs: ['ja'] });
		const a = requestImageTranslation('f1', 'n1');
		const b = requestImageTranslation('f1', 'n2');
		expect(a.value).toEqual({ status: 'loading' });
		await vi.waitFor(() => expect(a.value).toEqual({ status: 'ok', text: '번역', sourceLangs: ['ja'] }));
		expect(b.value).toEqual(a.value);
		expect(misskeyApi).toHaveBeenCalledTimes(1);
		expect(misskeyApi).toHaveBeenCalledWith('kyunet/translate-image', { fileId: 'f1', noteId: 'n1', targetLang: 'ko-KR' });
	});

	test('no text in the image is ok with a null text', async () => {
		misskeyApi.mockResolvedValueOnce({ status: 'ok', text: null, sourceLangs: [] });
		const s = requestImageTranslation('f2', 'n1');
		await vi.waitFor(() => expect(s.value).toEqual({ status: 'ok', text: null, sourceLangs: [] }));
	});

	test('a failure is kept, and retry asks the server again without skipping its cache', async () => {
		misskeyApi.mockRejectedValueOnce(new Error('network'));
		const s = requestImageTranslation('f3', 'n1');
		await vi.waitFor(() => expect(s.value).toEqual({ status: 'failed' }));
		expect(requestImageTranslation('f3', 'n1').value).toEqual({ status: 'failed' });

		misskeyApi.mockResolvedValueOnce({ status: 'failed', text: null, sourceLangs: [] });
		requestImageTranslation('f3', 'n1', { retry: true });
		await vi.waitFor(() => expect(misskeyApi).toHaveBeenLastCalledWith('kyunet/translate-image', { fileId: 'f3', noteId: 'n1', targetLang: 'ko-KR' }));
		await vi.waitFor(() => expect(s.value).toEqual({ status: 'failed' }));

		misskeyApi.mockResolvedValueOnce({ status: 'ok', text: '됨', sourceLangs: ['ja'] });
		const again = requestImageTranslation('f3', 'n1', { retry: true });
		expect(again.value).toEqual({ status: 'loading' });
		await vi.waitFor(() => expect(s.value).toEqual({ status: 'ok', text: '됨', sourceLangs: ['ja'] }));
	});

	test('retry does not ask again once there is a result', async () => {
		misskeyApi.mockResolvedValueOnce({ status: 'ok', text: '번역', sourceLangs: ['ja'] });
		const s = requestImageTranslation('f4', 'n1');
		await vi.waitFor(() => expect(s.value.status).toBe('ok'));
		const calls = misskeyApi.mock.calls.length;
		expect(requestImageTranslation('f4', 'n1', { retry: true })).toBe(s);
		expect(misskeyApi.mock.calls.length).toBe(calls);
	});
});

describe('createKyunetImageTranslationContext', () => {
	const files = [{ id: 'a', type: 'image/png' }, { id: 'v', type: 'video/mp4' }, { id: 'b', type: 'image/jpeg' }] as never;

	test('only the images of the note can be opened', () => {
		const ctx = createKyunetImageTranslationContext(() => files, () => {});
		expect(ctx.canOpen('a')).toBe(true);
		expect(ctx.canOpen('v')).toBe(false);
		expect(ctx.canOpen('other')).toBe(false);
		ctx.open('other');
		expect(ctx.selectedFileId.value).toBeNull();
	});

	test('opening calls onOpen (e.g. expand a collapsed note); the selected image again closes; another image switches', () => {
		const onOpen = vi.fn();
		const ctx = createKyunetImageTranslationContext(() => files, onOpen);
		ctx.open('a');
		expect(ctx.selectedFileId.value).toBe('a');
		expect(onOpen).toHaveBeenCalledTimes(1);
		ctx.open('b');
		expect(ctx.selectedFileId.value).toBe('b');
		expect(onOpen).toHaveBeenCalledTimes(2);
		ctx.open('b');
		expect(ctx.selectedFileId.value).toBeNull();
		expect(onOpen).toHaveBeenCalledTimes(2);
	});
});
