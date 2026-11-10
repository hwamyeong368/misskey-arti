<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- kyunet: when a translated name exists, append it after the original (dimmed). Upstream renders the Mfm alone (no v-else). -->
<span v-if="translatedName && !deidentified" :class="[$style.root, { [$style.nowrap]: nowrap }]">
	<Mfm :text="user.name ?? user.username" :author="user" :plain="true" :nowrap="nowrap" :emojiUrls="user.emojis"/>
	<Mfm :text="translatedName" :author="user" :plain="true" :nowrap="nowrap" :emojiUrls="user.emojis" :class="$style.translated"/>
</span>
<Mfm v-else :text="deidentified ? i18n.ts.mutedUsers : (user.name ?? user.username)" :author="user" :plain="true" :nowrap="nowrap" :emojiUrls="user.emojis"/>
</template>

<script lang="ts" setup>
// kyunet: upstream: empty vue import; replaced with the imports the translated name needs
import { computed, shallowRef, watch } from 'vue';
import * as Misskey from 'misskey-js';
// kyunet: fork-only translated display names
import type { Ref } from 'vue';
import { prefer } from '@/preferences.js';
import { i18n } from '@/i18n.js';
import { useKyunetTranslation } from '@/composables/use-kyunet-translation.js';
import type { KyunetTranslationResult } from '@/composables/use-kyunet-translation.js';

const props = withDefaults(defineProps<{
	user: Misskey.entities.User;
	nowrap?: boolean;
}>(), {
	nowrap: true,
});

// bscone: de-identify muted users (isMuted only exists on UserDetailed)
const deidentified = computed(() => prefer.s.deidentifyMutedUsers && 'isMuted' in props.user && props.user.isMuted === true);

// kyunet: ask the shared queue for `user_name` whenever the user changes; local users are asked too (cached server-side)
const translationRef = shallowRef<{ result: Ref<KyunetTranslationResult | null> } | null>(null);
watch(() => [props.user.id, props.user.name] as const, () => {
	if (!prefer.s['kyunetTranslation.userNames'] || props.user.name == null || props.user.name.trim() === '') {
		translationRef.value = null;
		return;
	}
	translationRef.value = { result: useKyunetTranslation().request({ type: 'user_name', id: props.user.id }) };
}, { immediate: true });

const translatedName = computed(() => {
	const res = translationRef.value?.result.value;
	return res != null && res.status === 'ok' && res.text != null && res.text !== props.user.name ? res.text : null;
});
</script>

<style lang="scss" module>
// kyunet: layout for "original  translated" display names
.root {
	display: inline;
}

.nowrap {
	white-space: nowrap;
}

.translated {
	margin-left: 0.5em;
	opacity: 0.7;
}
</style>
