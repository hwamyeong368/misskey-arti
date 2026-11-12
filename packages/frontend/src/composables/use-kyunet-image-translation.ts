/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: feat/llm-translation - feat/image-translation
// One state per image and target language for the whole page: a tab opened again, or the same image in another
// note display, reuses the result instead of asking the server (which would hit its cache, but still costs a request).

import { ref } from 'vue';
import type { InjectionKey, Ref } from 'vue';
import type * as Misskey from 'misskey-js';
import { $i } from '@/i.js';
import { instance } from '@/instance.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { kyunetTargetLang } from '@/composables/use-kyunet-translation.js';

/** Provided by a note that can translate its images; the image menu opens the block through it. `canOpen`: images of a quoted note inherit the context but are not the providing note's files. */
export type KyunetImageTranslationContext = {
	selectedFileId: Ref<string | null>;
	canOpen: (fileId: string) => boolean;
	open: (fileId: string) => void;
};
export const KYUNET_IMAGE_TRANSLATION_KEY: InjectionKey<KyunetImageTranslationContext | null> = Symbol();

export type KyunetImageTranslationState =
	| { status: 'loading' }
	| { status: 'ok'; text: string | null; sourceLangs: string[] }
	| { status: 'failed' };

const states = new Map<string, Ref<KyunetImageTranslationState>>();

export function isKyunetImageTranslationAvailable(): boolean {
	return $i != null && $i.policies.canUseTranslator && instance.llmImageTranslatorAvailable === true;
}

/** `retry` asks again only after a failure. It keeps the server cache: failures are not cached there, and a result is not re-generated. */
export function requestImageTranslation(fileId: string, noteId: string, opts: { retry?: boolean } = {}): Ref<KyunetImageTranslationState> {
	const targetLang = kyunetTargetLang();
	const key = `${fileId}:${targetLang}`;
	const existing = states.get(key);
	if (existing != null && !(opts.retry === true && existing.value.status === 'failed')) return existing;

	const state = existing ?? ref<KyunetImageTranslationState>({ status: 'loading' });
	state.value = { status: 'loading' };
	states.set(key, state);

	misskeyApi('kyunet/translate-image', { fileId, noteId, targetLang }).then(res => {
		state.value = res.status === 'ok' ? { status: 'ok', text: res.text, sourceLangs: res.sourceLangs } : { status: 'failed' };
	}, err => {
		console.warn(`[kyunet image translation] ${fileId}:`, err);
		state.value = { status: 'failed' };
	});
	return state;
}

/**
 * What a note provides to its images (KYUNET_IMAGE_TRANSLATION_KEY). `onOpen` runs when the block opens, so a
 * collapsed long note can expand: otherwise the block would mount below the fold and look like nothing happened.
 */
export function createKyunetImageTranslationContext(files: () => Misskey.entities.DriveFile[], onOpen: () => void): KyunetImageTranslationContext {
	const selectedFileId = ref<string | null>(null);
	const canOpen = (fileId: string) => files().some(f => f.id === fileId && f.type.startsWith('image/'));
	return {
		selectedFileId,
		canOpen,
		open: (fileId) => {
			if (!canOpen(fileId)) return;
			if (selectedFileId.value === fileId) {
				selectedFileId.value = null;
				return;
			}
			selectedFileId.value = fileId;
			onOpen();
		},
	};
}
