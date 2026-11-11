/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// arti: the text of a note that is sent for translation. Besides CW and body it carries the poll choices and
// the image descriptions (alt text) as marked lines, so they are translated together with the note.
// Keep in sync with packages/frontend/src/composables/use-kyunet-translation.ts (noteSourceText).

export const POLL_CHOICE_MARK = '📊';
export const FILE_COMMENT_MARK = '🖼️';

export function buildNoteTranslationSource(note: { cw: string | null; text: string | null }, pollChoices: readonly string[], fileComments: readonly (string | null)[]): string {
	let text = note.text ?? '';
	if (note.cw != null) text = `${note.cw}\n-----\n${text}`;
	const extra: string[] = [];
	for (const choice of pollChoices) if (choice.trim() !== '') extra.push(`${POLL_CHOICE_MARK} ${choice}`);
	for (const comment of fileComments) if (comment != null && comment.trim() !== '') extra.push(`${FILE_COMMENT_MARK} ${comment.replace(/\n+/g, ' ')}`);
	if (extra.length === 0) return text;
	return text.trim() === '' ? extra.join('\n') : `${text}\n\n${extra.join('\n')}`;
}
