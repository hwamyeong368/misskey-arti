/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { buildNoteTranslationSource } from '@/misc/kyunet-note-source.js';

describe('buildNoteTranslationSource', () => {
	test('text only is unchanged', () => {
		expect(buildNoteTranslationSource({ cw: null, text: 'hello' }, [], [])).toBe('hello');
	});

	test('cw, poll choices and file comments are appended', () => {
		expect(buildNoteTranslationSource({ cw: 'cw', text: 'body' }, ['a', ' '], ['x\ny', null, ''])).toBe('cw\n-----\nbody\n\n📊 a\n🖼️ x y');
	});

	test('no text: only extras', () => {
		expect(buildNoteTranslationSource({ cw: null, text: null }, ['a'], [])).toBe('📊 a');
	});
});
