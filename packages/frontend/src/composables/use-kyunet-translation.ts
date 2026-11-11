/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only composable around the global LLM translation queue (spec 7.1 / 7.3).
// Also owns the shared manual "translate this note" routine used by the footer button and the note menu.

import { computed } from 'vue';
import type { ComputedRef, Ref } from 'vue';
import type * as Misskey from 'misskey-js';
import { $i } from '@/i.js';
import { i18n } from '@/i18n.js';
import { instance } from '@/instance.js';
import { miLocalStorage } from '@/local-storage.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import * as os from '@/os.js';
import { KyunetTranslationQueue } from '@/utility/kyunet-translation-queue.js';
import type { KyunetTranslationRef, KyunetTranslationResult } from '@/utility/kyunet-translation-queue.js';

export type { KyunetTranslationRef, KyunetTranslationResult };

const queue = new KyunetTranslationQueue(async (items, targetLang, force = false) => {
	const res = await misskeyApi('kyunet/translate', { targetLang, items, force });
	return res.items;
});

export function kyunetTargetLang(): string {
	return miLocalStorage.getItem('lang') ?? navigator.language;
}

/** "en, ja" → "영어, 일본어" in the UI language; unknown or unsupported codes fall back to the code itself. */
export function kyunetLangNames(codes: readonly string[]): string {
	let names: Intl.DisplayNames | null = null;
	try {
		names = new Intl.DisplayNames([kyunetTargetLang()], { type: 'language', fallback: 'none' });
	} catch {
		names = null;
	}
	return codes.map(code => {
		try {
			return names?.of(code) ?? code;
		} catch {
			return code;
		}
	}).join(', ');
}

export function isKyunetTranslationAvailable(): boolean {
	return $i != null && $i.policies.canUseTranslator && instance.llmTranslatorAvailable === true;
}

export function useKyunetTranslation(): {
	available: ComputedRef<boolean>;
	targetLang: string;
	request: (ref: KyunetTranslationRef) => Ref<KyunetTranslationResult | null>;
	translateNow: (ref: KyunetTranslationRef) => Promise<KyunetTranslationResult>;
} {
	const targetLang = kyunetTargetLang();
	const available = computed(() => isKyunetTranslationAvailable());
	return {
		available,
		targetLang,
		request: (ref) => available.value ? queue.request(ref, targetLang) : nullRef(),
		translateNow: (ref) => queue.translateNow(ref, targetLang),
	};
}

function nullRef(): Ref<KyunetTranslationResult | null> {
	return computed(() => null) as unknown as Ref<KyunetTranslationResult | null>;
}

// keep in sync with backend src/misc/kyunet-note-source.ts (poll choices and image alt text are translated too)
export function noteSourceText(note: Misskey.entities.Note): string {
	let text = note.text ?? '';
	if (note.cw != null) text = `${note.cw}\n-----\n${text}`;
	const extra: string[] = [];
	for (const choice of note.poll?.choices ?? []) if (choice.text.trim() !== '') extra.push(`📊 ${choice.text}`);
	for (const file of note.files ?? []) if (file.comment != null && file.comment.trim() !== '') extra.push(`🖼️ ${file.comment.replace(/\n+/g, ' ')}`);
	if (extra.length === 0) return text;
	return text.trim() === '' ? extra.join('\n') : `${text}\n\n${extra.join('\n')}`;
}

/**
 * Manual translation shared by the footer button and the note menu.
 * Toggles: when a translation is shown it is cleared instead (spec 7.3 "되돌리기").
 * A cached `ok` result is reused; only an uncached / failed one triggers a forced server call.
 */
export async function translateNoteWith(
	note: Misskey.entities.Note,
	translation: Ref<Misskey.entities.NotesTranslateResponse | null>,
	translating: Ref<boolean>,
): Promise<void> {
	if (translation.value != null) {
		translation.value = null;
		return;
	}
	const text = noteSourceText(note);
	if (text.trim() === '') return;
	const noteRef: KyunetTranslationRef = { type: 'note', id: note.id };
	const targetLang = kyunetTargetLang();
	// re-showing a hidden translation restores it from the global cache without a server request (spec 7.3)
	const cached = queue.peek(noteRef, targetLang);
	if (cached?.status === 'ok') {
		translation.value = { sourceLang: kyunetLangNames(cached.sourceLangs), text: cached.text ?? text };
		return;
	}
	translating.value = true;
	try {
		const res = await queue.translateNow(noteRef, targetLang);
		if (res.status !== 'ok') {
			// one user-facing message for every non-success; the distinction stays in the console (and in the server log for LLM failures)
			console.warn(`[kyunet translation] note ${note.id}: ${res.status}`);
			os.alert({ type: 'error', text: i18n.ts._kyunetTranslation.translationFailed });
			return;
		}
		translation.value = {
			sourceLang: kyunetLangNames(res.sourceLangs),
			text: res.text ?? text, // null = nothing to translate -> show the source like the browser-translator path does
		};
	} finally {
		translating.value = false;
	}
}
