/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// kyunet: fork-only. Display names for the LLM translation's source language codes.

import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/os.js', () => ({ alert: vi.fn() }));
vi.mock('@/i.js', () => ({ $i: null }));
vi.mock('@/instance.js', () => ({ instance: {} }));

const { kyunetLangNames } = await import('@/composables/use-kyunet-translation.js');
const { i18n } = await import('@/i18n.js');

describe('kyunetLangNames', () => {
	beforeEach(() => {
		localStorage.setItem('lang', 'ko-KR');
	});

	test('drops the region so "ja-JP" reads as plain Japanese', () => {
		expect(kyunetLangNames(['ja-JP'])).toBe('일본어');
	});

	test('keeps the script so simplified and traditional Chinese stay distinct', () => {
		expect(kyunetLangNames(['zh-Hans', 'zh-Hant'])).toBe('중국어(간체), 중국어(번체)');
	});

	test('deduplicates codes that only differ by region', () => {
		expect(kyunetLangNames(['ja', 'ja-JP'])).toBe('일본어');
	});

	test('falls back to the code itself when it is not a valid tag', () => {
		expect(kyunetLangNames(['???'])).toBe('???');
	});

	test('an empty list reads as unknown instead of leaving the header blank', () => {
		expect(i18n.ts.unknown).toBeTruthy();
		expect(kyunetLangNames([])).toBe(i18n.ts.unknown);
	});
});
