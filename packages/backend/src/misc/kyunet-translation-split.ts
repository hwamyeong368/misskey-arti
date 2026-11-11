/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// arti: split a long text into pieces an LLM can translate one by one, keeping the separators so the
// translated pieces can be glued back with the original line breaks.

export type TextPiece = { text: string; sep: string };

// paragraphs → lines → sentences; anything still too long is cut by length as a last resort
const SPLIT_PATTERNS = [/(\n{2,})/, /(\n)/, /(?<=[.!?。！？])(\s+)/];

function hardCut(text: string, maxChars: number): TextPiece[] {
	const chars = Array.from(text); // do not cut surrogate pairs
	const pieces: TextPiece[] = [];
	for (let i = 0; i < chars.length; i += maxChars) {
		pieces.push({ text: chars.slice(i, i + maxChars).join(''), sep: '' });
	}
	return pieces;
}

/**
 * Splits `text` into pieces of at most `maxChars` characters (when possible) at paragraph, line or sentence
 * boundaries. `pieces.map(p => p.text + p.sep).join('')` always equals `text`.
 */
export function splitForTranslation(text: string, maxChars: number, level = 0): TextPiece[] {
	if (text.length <= maxChars) return [{ text, sep: '' }];
	if (level >= SPLIT_PATTERNS.length) return hardCut(text, maxChars);

	const tokens = text.split(SPLIT_PATTERNS[level]);
	if (tokens.length === 1) return splitForTranslation(text, maxChars, level + 1);

	const pieces: TextPiece[] = [];
	let current: TextPiece | null = null;
	for (let i = 0; i < tokens.length; i += 2) {
		const part = tokens[i];
		const sep = tokens[i + 1] ?? '';
		if (part.length > maxChars) {
			if (current != null) pieces.push(current);
			current = null;
			const sub = splitForTranslation(part, maxChars, level + 1);
			sub[sub.length - 1].sep += sep;
			pieces.push(...sub);
			continue;
		}
		if (current != null && current.text.length + current.sep.length + part.length <= maxChars) {
			current = { text: current.text + current.sep + part, sep };
		} else {
			if (current != null) pieces.push(current);
			current = { text: part, sep };
		}
	}
	if (current != null) pieces.push(current);
	// a piece made only of whitespace (e.g. leading spaces of a line) is folded into its neighbour's separator
	return pieces.filter((p, idx) => {
		if (p.text.trim() !== '' || pieces.length === 1) return true;
		const prev = pieces[idx - 1];
		if (prev != null) prev.sep += p.text + p.sep;
		return prev == null;
	});
}
