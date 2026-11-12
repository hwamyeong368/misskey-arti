/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only service. Loads the single-row LLM translation settings into memory, updates them,
// and invalidates every process through the existing per-host Redis pub/sub channel.

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { KyunetTranslationSettingsRepository } from '@/models/_.js';
import type { MiKyunetTranslationSetting, KyunetTranslationProvider } from '@/models/KyunetTranslationSetting.js';
import type { MiMeta } from '@/models/Meta.js';
import { bindThis } from '@/decorators.js';
// kyunet: feat/llm-translation - feat/image-translation
import { DEFAULT_IMAGE_SYSTEM_PROMPT } from '@/core/KyunetTranslationLlmClient.js';
import type { KyunetLlmConnection } from '@/core/KyunetTranslationLlmClient.js';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';

export const KYUNET_TRANSLATION_SETTING_ID = 'x';
export const KYUNET_PUBSUB_CHANNEL = 'kyunet';

export type KyunetTranslationSettingPatch = Partial<Omit<MiKyunetTranslationSetting, 'id' | 'updatedAt'>>;
// kyunet: feat/llm-translation - feat/image-translation
export type KyunetTranslationSettingPublic = Omit<MiKyunetTranslationSetting, 'apiKey' | 'imageApiKey'> & { apiKeySet: boolean; imageApiKeySet: boolean };

// kyunet: feat/llm-translation - feat/image-translation
function filled(value: string | null): boolean {
	return value != null && value.trim() !== '';
}

@Injectable()
export class KyunetTranslationSettingService implements OnModuleInit, OnApplicationShutdown {
	private cache: MiKyunetTranslationSetting | null = null;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.redisForPub)
		private redisForPub: Redis.Redis,

		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		@Inject(DI.kyunetTranslationSettingsRepository)
		private settingsRepository: KyunetTranslationSettingsRepository,
	) {
		this.redisForSub.on('message', this.onMessage);
	}

	async onModuleInit(): Promise<void> {
		await this.load();
	}

	onApplicationShutdown(): void {
		this.redisForSub.off('message', this.onMessage);
	}

	@bindThis
	private async onMessage(_: string, data: string): Promise<void> {
		const obj = JSON.parse(data);
		if (obj.channel !== KYUNET_PUBSUB_CHANNEL) return;
		if (obj.message?.type === 'translationSettingUpdated') {
			await this.load();
		}
	}

	@bindThis
	public async load(): Promise<MiKyunetTranslationSetting> {
		let row = await this.settingsRepository.findOneBy({ id: KYUNET_TRANSLATION_SETTING_ID });
		if (row == null) {
			await this.settingsRepository.insert({ id: KYUNET_TRANSLATION_SETTING_ID, updatedAt: new Date() });
			row = await this.settingsRepository.findOneBy({ id: KYUNET_TRANSLATION_SETTING_ID });
			if (row == null) throw new Error('kyunet_translation_setting row could not be created');
		}
		this.cache = row;
		return row;
	}

	/** Synchronous; valid after onModuleInit. */
	@bindThis
	public get(): MiKyunetTranslationSetting {
		if (this.cache == null) throw new Error('KyunetTranslationSettingService is not loaded yet');
		return this.cache;
	}

	/** `llmTranslatorAvailable` in the spec: enabled + baseUrl + model. */
	@bindThis
	public isAvailable(): boolean {
		const s = this.cache;
		if (s == null || !s.enabled) return false;
		return this.isProviderConfigured(s, s.provider);
	}

	/** arti: whether a provider has what it needs. DeepL reuses the instance-wide DeepL key instead of baseUrl / model. */
	@bindThis
	public isProviderConfigured(s: MiKyunetTranslationSetting, provider: KyunetTranslationProvider): boolean {
		if (provider === 'deepl') return this.meta.deeplAuthKey != null && this.meta.deeplAuthKey !== '';
		return s.baseUrl != null && s.baseUrl.trim() !== '' && s.model != null && s.model.trim() !== '';
	}

	/** arti: the provider to retry failed items with, or null when fallback is off or the other provider is not configured. */
	@bindThis
	public fallbackProvider(s: MiKyunetTranslationSetting): KyunetTranslationProvider | null {
		if (!s.fallbackEnabled) return null;
		const other: KyunetTranslationProvider = s.provider === 'deepl' ? 'openai' : 'deepl';
		return this.isProviderConfigured(s, other) ? other : null;
	}

	// kyunet: feat/llm-translation - feat/image-translation
	/** The image path's effective connection: image* fields only with imageSeparateConnection; the prompt is always image-only. */
	@bindThis
	public getImageConnection(): KyunetLlmConnection {
		const s = this.get();
		const systemPrompt = s.imageSystemPrompt ?? DEFAULT_IMAGE_SYSTEM_PROMPT;
		if (!s.imageSeparateConnection) {
			return {
				baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, extraParams: s.extraParams, structuredOutput: s.structuredOutput,
				timeoutMs: s.timeoutMs, maxConcurrency: s.maxConcurrency, maxTokensParam: s.maxTokensParam, systemPrompt, semaphoreScope: 'text',
			};
		}
		return {
			baseUrl: s.imageBaseUrl, apiKey: s.imageApiKey, model: s.imageModel, extraParams: s.imageExtraParams, structuredOutput: s.imageStructuredOutput,
			timeoutMs: s.imageTimeoutMs, maxConcurrency: s.imageMaxConcurrency, maxTokensParam: s.imageMaxTokensParam, systemPrompt, semaphoreScope: 'image',
		};
	}

	// kyunet: feat/llm-translation - feat/image-translation
	/** `llmImageTranslatorAvailable`: text translation on, image translation on, and the effective connection is complete. */
	@bindThis
	public isImageAvailable(): boolean {
		if (this.cache == null) return false;
		if (!this.cache.enabled || !this.cache.imageEnabled) return false;
		const conn = this.getImageConnection();
		return filled(conn.baseUrl) && filled(conn.model);
	}

	@bindThis
	public async update(patch: KyunetTranslationSettingPatch): Promise<MiKyunetTranslationSetting> {
		const set: Record<string, unknown> = { ...patch, updatedAt: new Date() };
		if (patch.apiKey === undefined) {
			delete set.apiKey;
		} else if (patch.apiKey === '') {
			set.apiKey = null;
		}
		// kyunet: feat/llm-translation - feat/image-translation
		if (patch.imageApiKey === undefined) {
			delete set.imageApiKey;
		} else if (patch.imageApiKey === '') {
			set.imageApiKey = null;
		}
		// Upsert rather than update: the row may be gone (e.g. the e2e harness drops the schema after boot),
		// and a plain update would then silently affect 0 rows while the in-memory cache looks updated.
		await this.settingsRepository.upsert({ id: KYUNET_TRANSLATION_SETTING_ID, ...set }, ['id']);
		await this.load();
		this.redisForPub.publish(this.config.host, JSON.stringify({
			channel: KYUNET_PUBSUB_CHANNEL,
			message: { type: 'translationSettingUpdated' },
		}));
		return this.get();
	}

	@bindThis
	public toPublic(): KyunetTranslationSettingPublic {
		// kyunet: feat/llm-translation - feat/image-translation
		const { apiKey, imageApiKey, ...rest } = this.get();
		return { ...rest, apiKeySet: apiKey != null && apiKey !== '', imageApiKeySet: imageApiKey != null && imageApiKey !== '' };
	}
}
