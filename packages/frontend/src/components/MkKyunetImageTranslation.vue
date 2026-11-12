<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<!-- kyunet: feat/llm-translation - feat/image-translation -->
<!-- One tab per image; a tab asks the server the first time it is selected. No height cap: a manga page can be long. -->

<template>
<div :class="$style.root">
	<div v-if="files.length > 1" :class="$style.tabs" role="tablist">
		<button
			v-for="(file, i) in files"
			:key="file.id"
			class="_button"
			:class="[$style.tab, { [$style.tabActive]: file.id === selectedFileId }]"
			role="tab"
			:aria-label="i18n.tsx._kyunetTranslation.imageTab({ n: i + 1 })"
			:aria-selected="file.id === selectedFileId"
			@click="emit('update:selectedFileId', file.id)"
		>{{ i + 1 }}</button>
	</div>

	<MkLoading v-if="state.status === 'loading'" mini/>
	<div v-else-if="state.status === 'failed'" :class="$style.message">
		<span>{{ i18n.ts._kyunetTranslation.imageTranslationFailed }}</span>
		<MkButton inline small @click="retry">{{ i18n.ts.retry }}</MkButton>
	</div>
	<div v-else-if="state.text == null" :class="$style.message">{{ i18n.ts._kyunetTranslation.imageNoText }}</div>
	<div v-else>
		<b>{{ i18n.tsx.translatedFrom({ x: kyunetLangNames(state.sourceLangs) }) }}: </b>
		<div :class="$style.text" class="_selectable">{{ state.text }}</div>
	</div>
</div>
</template>

<script lang="ts" setup>
import { computed, shallowRef, watch } from 'vue';
import type { Ref } from 'vue';
import * as Misskey from 'misskey-js';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import { kyunetLangNames } from '@/composables/use-kyunet-translation.js';
import { requestImageTranslation } from '@/composables/use-kyunet-image-translation.js';
import type { KyunetImageTranslationState } from '@/composables/use-kyunet-image-translation.js';

const props = defineProps<{
	files: Misskey.entities.DriveFile[];
	noteId: string;
	selectedFileId: string;
}>();

const emit = defineEmits<{
	(ev: 'update:selectedFileId', fileId: string): void;
}>();

// wrapped: shallowRef(aRef) would return aRef itself instead of holding it
const current = shallowRef<{ state: Ref<KyunetImageTranslationState> }>({ state: requestImageTranslation(props.selectedFileId, props.noteId) });
watch(() => props.selectedFileId, (fileId) => {
	current.value = { state: requestImageTranslation(fileId, props.noteId) };
});

const state = computed(() => current.value.state.value);

function retry() {
	current.value = { state: requestImageTranslation(props.selectedFileId, props.noteId, { retry: true }) };
}
</script>

<style lang="scss" module>
.root {
	border: solid 0.5px var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
	padding: 12px;
	margin-top: 8px;
}

.tabs {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	margin-bottom: 8px;
}

.tab {
	min-width: 28px;
	padding: 2px 8px;
	border-radius: 999px;
	background: var(--MI_THEME-buttonBg);
	font-size: 0.85em;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.tabActive {
	background: var(--MI_THEME-accent);
	color: var(--MI_THEME-fgOnAccent);

	&:hover {
		background: var(--MI_THEME-accent);
	}
}

.message {
	display: flex;
	align-items: center;
	gap: 8px;
	opacity: 0.8;
}

.text {
	white-space: pre-wrap;
	word-break: break-word;
}
</style>
