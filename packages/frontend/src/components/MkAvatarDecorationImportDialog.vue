<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- arti: copy a decoration a remote user wears into this server (idea from CherryPick's decoration copy) -->
<template>
<MkModalWindow
	ref="dialogEl"
	:width="400"
	:height="450"
	:withOkButton="false"
	@close="dialogEl?.close()"
	@closed="emit('closed')"
>
	<template #header><i class="ti ti-download"></i> {{ i18n.ts.importAvatarDecoration }}</template>

	<div class="_spacer" style="--MI_SPACER-min: 16px; --MI_SPACER-max: 20px;">
		<div class="_gaps">
			<div :class="$style.description">{{ i18n.ts.importAvatarDecorationDescription }}</div>
			<div :class="$style.grid">
				<button
					v-for="decoration in user.avatarDecorations"
					:key="decoration.id"
					class="_button"
					:class="[$style.item, { [$style.done]: imported.includes(decoration.id) }]"
					:disabled="imported.includes(decoration.id)"
					:aria-label="i18n.ts.importAvatarDecoration"
					@click="importDecoration(decoration)"
				>
					<img :src="decoration.url" :class="$style.img" alt="" draggable="false"/>
					<i v-if="imported.includes(decoration.id)" class="ti ti-check" :class="$style.doneIcon"></i>
				</button>
			</div>
		</div>
	</div>
</MkModalWindow>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import * as Misskey from 'misskey-js';
import MkModalWindow from '@/components/MkModalWindow.vue';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';

const props = defineProps<{
	user: Misskey.entities.UserDetailed;
}>();

const emit = defineEmits<{
	(ev: 'closed'): void;
}>();

const dialogEl = ref<InstanceType<typeof MkModalWindow>>();
const imported = ref<string[]>([]);

async function importDecoration(decoration: Misskey.entities.UserDetailed['avatarDecorations'][number]) {
	const { canceled, result: name } = await os.inputText({
		title: i18n.ts.name,
		minLength: 1,
	});
	if (canceled || name == null || name === '') return;

	await os.apiWithDialog('admin/avatar-decorations/import-from-remote-user', {
		userId: props.user.id,
		decorationId: decoration.id,
		name,
	});
	imported.value.push(decoration.id);
}
</script>

<style lang="scss" module>
.description {
	font-size: 0.9em;
	opacity: 0.8;
}

.grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
	gap: 12px;
}

.item {
	position: relative;
	aspect-ratio: 1;
	padding: 8px;
	border-radius: 8px;
	background: var(--MI_THEME-panel);
	border: solid 2px transparent;

	&:hover {
		border-color: var(--MI_THEME-divider);
	}

	&.done {
		border-color: var(--MI_THEME-success);

		> .img {
			opacity: 0.3;
		}
	}
}

.img {
	width: 100%;
	height: 100%;
	object-fit: contain;
}

.doneIcon {
	position: absolute;
	top: 50%;
	left: 50%;
	translate: -50% -50%;
	font-size: 1.6em;
	color: var(--MI_THEME-success);
}
</style>
