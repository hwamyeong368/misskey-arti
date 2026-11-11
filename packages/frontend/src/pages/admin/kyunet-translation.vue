<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<!-- kyunet: fork-only admin page for the LLM translation settings (spec 7.6) -->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 700px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<div class="_gaps_m">
			<MkInfo>{{ i18n.ts._kyunetTranslation.description }}</MkInfo>

			<MkFolder :defaultOpen="true">
				<template #label>{{ i18n.ts._kyunetTranslation.title }}</template>

				<div class="_gaps_m">
					<MkSwitch v-model="form.enabled">
						<template #label>{{ i18n.ts._kyunetTranslation.enabled }}</template>
					</MkSwitch>

					<!-- arti: translation backend switch (OpenAI-compatible LLM / DeepL) -->
					<MkSelect v-model="provider" :items="providerDef">
						<template #label>{{ i18n.ts._kyunetTranslation.provider }}</template>
					</MkSelect>

					<!-- arti: retry failed items with the other provider -->
					<MkSwitch v-model="form.fallbackEnabled">
						<template #label>{{ i18n.ts._kyunetTranslation.fallbackEnabled }}</template>
						<template #caption>{{ i18n.ts._kyunetTranslation.fallbackEnabled_description }}</template>
					</MkSwitch>

					<!-- arti: DeepL usage in the current billing period (also useful when DeepL is only the fallback) -->
					<MkKeyValue v-if="deeplUsage != null">
						<template #key>{{ i18n.ts._kyunetTranslation.deeplUsage }}</template>
						<template #value>{{ i18n.tsx._kyunetTranslation.deeplUsageValue({ count: deeplUsage.count.toLocaleString(), limit: deeplUsage.limit.toLocaleString(), percent: deeplUsage.limit > 0 ? Math.round(deeplUsage.count / deeplUsage.limit * 100) : 0 }) }}</template>
					</MkKeyValue>

					<template v-if="provider === 'deepl'">
						<MkInfo>{{ i18n.ts._kyunetTranslation.deeplKeyNote }}</MkInfo>
						<MkInfo v-if="!deeplAuthKeySet" warn>{{ i18n.ts._kyunetTranslation.deeplKeyMissing }}</MkInfo>
						<MkInfo warn>{{ i18n.ts._kyunetTranslation.providerPrivacyWarning }}</MkInfo>
					</template>

					<template v-if="provider === 'openai'">
						<MkInput v-model="form.baseUrl" type="url">
							<template #prefix><i class="ti ti-link"></i></template>
							<template #label>{{ i18n.ts._kyunetTranslation.baseUrl }}</template>
							<template #caption>{{ i18n.ts._kyunetTranslation.baseUrlCaption }}</template>
						</MkInput>
						<MkInfo warn>{{ i18n.ts._kyunetTranslation.providerPrivacyWarning }}</MkInfo>

						<MkInput v-model="form.apiKey" type="password" autocomplete="off">
							<template #prefix><i class="ti ti-key"></i></template>
							<template #label>{{ i18n.ts._kyunetTranslation.apiKey }} <span v-if="apiKeySet" class="_beta">{{ i18n.ts._kyunetTranslation.apiKeySet }}</span></template>
							<template #caption>{{ i18n.ts._kyunetTranslation.apiKeyCaption }}</template>
						</MkInput>
						<MkButton v-if="apiKeySet" danger @click="deleteApiKey">{{ i18n.ts._kyunetTranslation.deleteApiKey }}</MkButton>

						<MkInput v-model="form.model">
							<template #prefix><i class="ti ti-cpu"></i></template>
							<template #label>{{ i18n.ts._kyunetTranslation.model }}</template>
						</MkInput>

						<MkTextarea v-model="form.extraParams" code>
							<template #label>{{ i18n.ts._kyunetTranslation.extraParams }}</template>
							<template #caption>{{ i18n.ts._kyunetTranslation.extraParamsOverrideNote }}</template>
						</MkTextarea>

						<MkTextarea v-model="form.systemPrompt" tall :placeholder="defaultSystemPrompt">
							<template #label>{{ i18n.ts._kyunetTranslation.systemPrompt }}</template>
							<template #caption>{{ i18n.ts._kyunetTranslation.systemPromptCaption }}</template>
						</MkTextarea>

						<MkSwitch v-model="form.structuredOutput">
							<template #label>{{ i18n.ts._kyunetTranslation.structuredOutput }}</template>
						</MkSwitch>

						<MkSelect v-model="maxTokensParam" :items="maxTokensParamDef">
							<template #label>{{ i18n.ts._kyunetTranslation.maxTokensParam }}</template>
						</MkSelect>
					</template>

					<MkInput v-model="form.timeoutMs" type="number" :min="1000" :max="600000">
						<template #label>{{ i18n.ts._kyunetTranslation.timeoutMs }}</template>
					</MkInput>

					<MkInput v-model="form.maxConcurrency" type="number" :min="1" :max="256">
						<template #label>{{ i18n.ts._kyunetTranslation.maxConcurrency }}</template>
					</MkInput>

					<MkInput v-model="form.maxInputLength" type="number" :min="1" :max="100000">
						<template #label>{{ i18n.ts._kyunetTranslation.maxInputLength }}</template>
					</MkInput>

					<MkInput v-model="form.batchMaxChars" type="number" :min="1" :max="200000">
						<template #label>{{ i18n.ts._kyunetTranslation.batchMaxChars }}</template>
					</MkInput>

					<MkInput v-model="form.batchMaxItems" type="number" :min="1" :max="50">
						<template #label>{{ i18n.ts._kyunetTranslation.batchMaxItems }}</template>
						<template #caption>{{ i18n.ts._kyunetTranslation.batchMaxItems_description }}</template>
					</MkInput>

					<MkSwitch v-model="form.heuristicGate">
						<template #label>{{ i18n.ts._kyunetTranslation.heuristicGate }}</template>
						<template #caption>{{ i18n.ts._kyunetTranslation.heuristicGate_description }}</template>
					</MkSwitch>

					<MkInput v-model="form.cacheRetentionDays" type="number" :min="0" :max="3650">
						<template #label>{{ i18n.ts._kyunetTranslation.cacheRetentionDays }}</template>
					</MkInput>

					<MkButton primary @click="save">{{ i18n.ts.save }}</MkButton>
				</div>
			</MkFolder>

			<MkFolder>
				<template #label>{{ i18n.ts._kyunetTranslation.testTranslation }}</template>

				<div class="_gaps_m">
					<MkTextarea v-model="testText">
						<template #label>{{ i18n.ts._kyunetTranslation.testText }}</template>
					</MkTextarea>
					<MkInput v-model="testTargetLang">
						<template #label>{{ i18n.ts._kyunetTranslation.targetLang }}</template>
					</MkInput>
					<MkButton primary :disabled="testing" @click="runTest">{{ i18n.ts._kyunetTranslation.runTest }}</MkButton>

					<div v-if="testResult" class="_gaps_s">
						<MkKeyValue>
							<template #key>{{ i18n.ts._kyunetTranslation.latency }}</template>
							<template #value>{{ testResult.latencyMs }} ms</template>
						</MkKeyValue>
						<MkInfo v-if="!testResult.ok" warn>{{ testResult.error }}</MkInfo>
						<MkKeyValue v-else-if="testResult.needsTranslation === false">
							<template #key>{{ i18n.ts._kyunetTranslation.result }}</template>
							<template #value>{{ i18n.ts._kyunetTranslation.noTranslationNeeded }} ({{ (testResult.sourceLangs ?? []).join(', ') }})</template>
						</MkKeyValue>
						<MkKeyValue v-else>
							<template #key>{{ i18n.ts._kyunetTranslation.result }} ({{ (testResult.sourceLangs ?? []).join(', ') }})</template>
							<template #value><pre :class="$style.pre">{{ testResult.text }}</pre></template>
						</MkKeyValue>
						<MkFolder v-if="testResult.raw">
							<template #label>{{ i18n.ts._kyunetTranslation.rawResponse }}</template>
							<pre :class="$style.pre">{{ testResult.raw }}</pre>
						</MkFolder>
					</div>
				</div>
			</MkFolder>

			<MkFolder>
				<template #label>{{ i18n.ts._kyunetTranslation.stats }}</template>

				<div v-if="stats" class="_gaps_s">
					<MkKeyValue oneline><template #key>{{ i18n.ts._kyunetTranslation.cacheRows }}</template><template #value>{{ stats.cacheRows }}</template></MkKeyValue>
					<MkKeyValue oneline><template #key>{{ i18n.ts._kyunetTranslation.gateSkipped }}</template><template #value>{{ stats.gateSkipped }}</template></MkKeyValue>
					<MkKeyValue oneline><template #key>{{ i18n.ts._kyunetTranslation.cacheHits }}</template><template #value>{{ stats.cacheHits }}</template></MkKeyValue>
					<MkKeyValue oneline><template #key>{{ i18n.ts._kyunetTranslation.llmItems }}</template><template #value>{{ stats.llmItems }}</template></MkKeyValue>
					<MkKeyValue oneline><template #key>{{ i18n.ts._kyunetTranslation.llmCalls }}</template><template #value>{{ stats.llmCalls }}</template></MkKeyValue>
					<MkKeyValue oneline><template #key>{{ i18n.ts._kyunetTranslation.llmFailures }}</template><template #value>{{ stats.llmFailures }}</template></MkKeyValue>
					<MkKeyValue oneline><template #key>{{ i18n.ts._kyunetTranslation.gateSavingRate }}</template><template #value>{{ percent(stats.gateSkipped, stats.gateSkipped + stats.llmItems) }}</template></MkKeyValue>
					<MkKeyValue oneline><template #key>{{ i18n.ts._kyunetTranslation.cacheHitRate }}</template><template #value>{{ percent(stats.cacheHits, stats.cacheHits + stats.llmItems) }}</template></MkKeyValue>
					<MkButton @click="reload">{{ i18n.ts.reload }}</MkButton>
				</div>
			</MkFolder>

			<MkFolder>
				<template #label>{{ i18n.ts._kyunetTranslation.cache }}</template>

				<div class="_gaps_m">
					<MkButton danger @click="clearAll">{{ i18n.ts._kyunetTranslation.clearAll }}</MkButton>
					<MkButton @click="clearOlderThan">{{ i18n.ts._kyunetTranslation.clearOlderThan }}</MkButton>
					<MkButton @click="clearByModel">{{ i18n.ts._kyunetTranslation.clearByModel }}</MkButton>
					<MkButton @click="clearByNoteId">{{ i18n.ts._kyunetTranslation.clearByNoteId }}</MkButton>
				</div>
			</MkFolder>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { ref, computed, reactive } from 'vue';
import * as Misskey from 'misskey-js';
import MkInput from '@/components/MkInput.vue';
import MkButton from '@/components/MkButton.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkFolder from '@/components/MkFolder.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { fetchInstance } from '@/instance.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { useMkSelect } from '@/composables/use-mkselect.js';
import { miLocalStorage } from '@/local-storage.js';

type Show = Misskey.Endpoints['admin/kyunet/translation/show']['res'];
type TestRes = Misskey.Endpoints['admin/kyunet/translation/test']['res'];

const current = await misskeyApi('admin/kyunet/translation/show');

const apiKeySet = ref(current.apiKeySet);
const deeplAuthKeySet = ref(current.deeplAuthKeySet);
const deeplUsage = ref(current.deeplUsage);
const stats = ref<Show['stats'] | null>(current.stats);
const defaultSystemPrompt = current.defaultSystemPrompt;

const form = reactive({
	enabled: current.enabled,
	fallbackEnabled: current.fallbackEnabled,
	baseUrl: current.baseUrl ?? '',
	apiKey: '',
	model: current.model ?? '',
	extraParams: JSON.stringify(current.extraParams ?? {}, null, 2),
	systemPrompt: current.systemPrompt ?? '',
	structuredOutput: current.structuredOutput,
	timeoutMs: current.timeoutMs,
	maxConcurrency: current.maxConcurrency,
	maxInputLength: current.maxInputLength,
	batchMaxChars: current.batchMaxChars,
	batchMaxItems: current.batchMaxItems,
	heuristicGate: current.heuristicGate,
	cacheRetentionDays: current.cacheRetentionDays,
});

const { model: maxTokensParam, def: maxTokensParamDef } = useMkSelect({
	items: [
		{ label: 'max_completion_tokens', value: 'max_completion_tokens' as const },
		{ label: 'max_tokens', value: 'max_tokens' as const },
	],
	initialValue: current.maxTokensParam,
});

const { model: provider, def: providerDef } = useMkSelect({
	items: [
		{ label: i18n.ts._kyunetTranslation.providerOpenai, value: 'openai' as const },
		{ label: 'DeepL', value: 'deepl' as const },
	],
	initialValue: current.provider,
});

async function save() {
	let extraParams: Record<string, unknown>;
	try {
		extraParams = form.extraParams.trim() === '' ? {} : JSON.parse(form.extraParams);
		if (extraParams == null || typeof extraParams !== 'object' || Array.isArray(extraParams)) throw new Error('not an object');
	} catch {
		os.alert({ type: 'error', text: i18n.ts._kyunetTranslation.extraParamsInvalidJson });
		return;
	}
	await os.apiWithDialog('admin/kyunet/translation/update', {
		enabled: form.enabled,
		provider: provider.value,
		fallbackEnabled: form.fallbackEnabled,
		baseUrl: form.baseUrl,
		...(form.apiKey !== '' ? { apiKey: form.apiKey } : {}),
		model: form.model,
		extraParams,
		systemPrompt: form.systemPrompt,
		structuredOutput: form.structuredOutput,
		timeoutMs: Number(form.timeoutMs),
		maxConcurrency: Number(form.maxConcurrency),
		maxTokensParam: maxTokensParam.value,
		maxInputLength: Number(form.maxInputLength),
		batchMaxChars: Number(form.batchMaxChars),
		batchMaxItems: Number(form.batchMaxItems),
		heuristicGate: form.heuristicGate,
		cacheRetentionDays: Number(form.cacheRetentionDays),
	});
	form.apiKey = '';
	await reload();
	fetchInstance(true);
}

async function deleteApiKey() {
	const { canceled } = await os.confirm({ type: 'warning', text: i18n.ts._kyunetTranslation.deleteApiKeyConfirm });
	if (canceled) return;
	await os.apiWithDialog('admin/kyunet/translation/update', { apiKey: '' });
	await reload();
}

async function reload() {
	const s = await misskeyApi('admin/kyunet/translation/show');
	apiKeySet.value = s.apiKeySet;
	deeplAuthKeySet.value = s.deeplAuthKeySet;
	deeplUsage.value = s.deeplUsage;
	stats.value = s.stats;
}

const testText = ref('');
const testTargetLang = ref(miLocalStorage.getItem('lang') ?? 'ko-KR');
const testing = ref(false);
const testResult = ref<TestRes | null>(null);

async function runTest() {
	if (testText.value.trim() === '') return;
	testing.value = true;
	try {
		testResult.value = await misskeyApi('admin/kyunet/translation/test', { text: testText.value, targetLang: testTargetLang.value });
	} finally {
		testing.value = false;
	}
}

function percent(n: number, d: number): string {
	return d === 0 ? '-' : `${Math.round((n / d) * 1000) / 10}%`;
}

async function afterClear(res: { deleted: number }) {
	os.toast(i18n.tsx._kyunetTranslation.cleared({ n: res.deleted }));
	await reload();
}

async function clearAll() {
	const { canceled } = await os.confirm({ type: 'warning', text: i18n.ts._kyunetTranslation.clearAllConfirm });
	if (canceled) return;
	await afterClear(await os.apiWithDialog('admin/kyunet/translation/clear-cache', { all: true }));
}

async function clearOlderThan() {
	const { canceled, result } = await os.inputNumber({ title: i18n.ts._kyunetTranslation.clearOlderThan, default: 30 });
	if (canceled || result == null) return;
	await afterClear(await os.apiWithDialog('admin/kyunet/translation/clear-cache', { olderThanDays: result }));
}

async function clearByModel() {
	const { canceled, result } = await os.inputText({ title: i18n.ts._kyunetTranslation.clearByModel, default: provider.value === 'deepl' ? 'deepl' : form.model });
	if (canceled || result == null || result === '') return;
	await afterClear(await os.apiWithDialog('admin/kyunet/translation/clear-cache', { model: result }));
}

async function clearByNoteId() {
	const { canceled, result } = await os.inputText({ title: i18n.ts._kyunetTranslation.clearByNoteId, default: '' });
	if (canceled || result == null || result === '') return;
	await afterClear(await os.apiWithDialog('admin/kyunet/translation/clear-cache', { noteId: result }));
}

const headerActions = computed(() => []);
const headerTabs = computed(() => []);

definePage(() => ({
	title: i18n.ts._kyunetTranslation.title,
	icon: 'ti ti-language-hiragana',
}));
</script>

<style lang="scss" module>
.pre {
	margin: 0;
	white-space: pre-wrap;
	word-break: break-all;
	font-size: 85%;
}
</style>
