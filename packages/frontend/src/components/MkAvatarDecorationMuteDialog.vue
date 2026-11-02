<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- arti: pick individual avatar decorations to hide (muted by image URL, so the same decoration is hidden on everyone) -->
<template>
<MkModalWindow
	ref="dialogEl"
	:width="400"
	:height="450"
	:withOkButton="false"
	@close="dialogEl?.close()"
	@closed="emit('closed')"
>
	<template #header><i class="ti ti-sparkles"></i> {{ i18n.ts.avatarDecoMuteEach }}</template>

	<div class="_spacer" style="--MI_SPACER-min: 16px; --MI_SPACER-max: 20px;">
		<div class="_gaps">
			<div :class="$style.description">{{ i18n.ts.avatarDecoMuteEachDescription }}</div>
			<div v-if="items.length === 0" :class="$style.empty">{{ i18n.ts.nothing }}</div>
			<div v-else :class="$style.grid">
				<button
					v-for="url in items"
					:key="url"
					class="_button"
					:class="[$style.item, { [$style.muted]: muted.includes(url) }]"
					:aria-pressed="muted.includes(url)"
					:aria-label="muted.includes(url) ? i18n.ts.avatarDecoUnmute : i18n.ts.avatarDecoMute"
					@click="toggle(url)"
				>
					<img :src="url" :class="$style.img" alt="" draggable="false"/>
					<i v-if="muted.includes(url)" class="ti ti-eye-off" :class="$style.mutedIcon"></i>
				</button>
			</div>
		</div>
	</div>
</MkModalWindow>
</template>

<script lang="ts" setup>
import { ref } from 'vue';
import MkModalWindow from '@/components/MkModalWindow.vue';
import { prefer } from '@/preferences.js';
import { i18n } from '@/i18n.js';

const props = defineProps<{
	// decoration image URLs to show; kept as given so an unmuted item stays visible and can be muted again
	urls: string[];
}>();

const emit = defineEmits<{
	(ev: 'closed'): void;
}>();

const dialogEl = ref<InstanceType<typeof MkModalWindow>>();
const items = [...new Set(props.urls)];
const muted = prefer.r.mutedAvatarDecorations;

function toggle(url: string) {
	const list = prefer.s.mutedAvatarDecorations;
	if (list.includes(url)) {
		prefer.commit('mutedAvatarDecorations', list.filter(x => x !== url));
	} else {
		prefer.commit('mutedAvatarDecorations', list.concat(url));
	}
}
</script>

<style lang="scss" module>
.description {
	font-size: 0.9em;
	opacity: 0.8;
}

.empty {
	text-align: center;
	opacity: 0.7;
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

	&.muted {
		border-color: var(--MI_THEME-accent);

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

.mutedIcon {
	position: absolute;
	top: 50%;
	left: 50%;
	translate: -50% -50%;
	font-size: 1.6em;
	color: var(--MI_THEME-accent);
}
</style>
