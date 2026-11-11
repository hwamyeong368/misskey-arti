/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { splitForTranslation } from '@/misc/kyunet-translation-split.js';

const glue = (pieces: { text: string; sep: string }[]) => pieces.map(p => p.text + p.sep).join('');

describe('splitForTranslation', () => {
	test('short text stays whole', () => {
		expect(splitForTranslation('hello', 10)).toEqual([{ text: 'hello', sep: '' }]);
	});

	test('splits at paragraphs and keeps separators', () => {
		const text = 'aaaa\n\nbbbb\n\n\ncccc';
		const pieces = splitForTranslation(text, 6);
		expect(pieces.map(p => p.text)).toEqual(['aaaa', 'bbbb', 'cccc']);
		expect(glue(pieces)).toBe(text);
	});

	test('packs small paragraphs together', () => {
		const text = 'aa\n\nbb\n\ncccccc';
		const pieces = splitForTranslation(text, 7);
		expect(pieces.map(p => p.text)).toEqual(['aa\n\nbb', 'cccccc']);
		expect(glue(pieces)).toBe(text);
	});

	test('falls back to lines, sentences and length', () => {
		const text = `${'あ'.repeat(5)}。${'い'.repeat(5)}。\n${'x'.repeat(25)}`;
		const pieces = splitForTranslation(text, 8);
		expect(pieces.every(p => p.text.length <= 8)).toBe(true);
		expect(glue(pieces)).toBe(text);
	});

	test('never cuts emoji surrogate pairs', () => {
		const text = '😀'.repeat(10);
		const pieces = splitForTranslation(text, 3);
		expect(glue(pieces)).toBe(text);
		expect(pieces.every(p => !/[\uD800-\uDBFF]$/.test(p.text))).toBe(true);
	});

	test('round-trips random-ish text', () => {
		const text = Array.from({ length: 40 }, (_, i) => `line ${i}. more words here!${i % 5 === 0 ? '\n\n' : '\n'}`).join('').trim();
		for (const max of [10, 50, 200]) expect(glue(splitForTranslation(text, max))).toBe(text);
	});
});
