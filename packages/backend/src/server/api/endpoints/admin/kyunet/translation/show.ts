/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only admin endpoint: current LLM translation settings (apiKey redacted) + stats (spec 6.2).

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/Meta.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { KyunetTranslationSettingService } from '@/core/KyunetTranslationSettingService.js';
import { KyunetTranslationService } from '@/core/KyunetTranslationService.js';
import { DEFAULT_SYSTEM_PROMPT } from '@/core/KyunetTranslationLlmClient.js';
import { KyunetTranslationDeeplClient } from '@/core/KyunetTranslationDeeplClient.js';
// kyunet: feat/llm-translation - feat/image-translation
import { DEFAULT_IMAGE_SYSTEM_PROMPT } from '@/core/KyunetTranslationLlmClient.js';

export const meta = {
	tags: ['admin', 'kyunet'],

	requireCredential: true,
	requireAdmin: true,
	kind: 'read:admin:meta',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			enabled: { type: 'boolean', optional: false, nullable: false },
			provider: { type: 'string', optional: false, nullable: false, enum: ['openai', 'deepl'] },
			deeplAuthKeySet: { type: 'boolean', optional: false, nullable: false },
			deeplUsage: {
				type: 'object',
				optional: false, nullable: true,
				properties: {
					count: { type: 'integer', optional: false, nullable: false },
					limit: { type: 'integer', optional: false, nullable: false },
				},
			},
			fallbackEnabled: { type: 'boolean', optional: false, nullable: false },
			baseUrl: { type: 'string', optional: false, nullable: true },
			apiKeySet: { type: 'boolean', optional: false, nullable: false },
			model: { type: 'string', optional: false, nullable: true },
			extraParams: { type: 'object', optional: false, nullable: false, additionalProperties: true },
			systemPrompt: { type: 'string', optional: false, nullable: true },
			structuredOutput: { type: 'boolean', optional: false, nullable: false },
			timeoutMs: { type: 'integer', optional: false, nullable: false },
			maxConcurrency: { type: 'integer', optional: false, nullable: false },
			maxTokensParam: { type: 'string', optional: false, nullable: false, enum: ['max_completion_tokens', 'max_tokens'] },
			maxInputLength: { type: 'integer', optional: false, nullable: false },
			batchMaxChars: { type: 'integer', optional: false, nullable: false },
			batchMaxItems: { type: 'integer', optional: false, nullable: false },
			heuristicGate: { type: 'boolean', optional: false, nullable: false },
			cacheRetentionDays: { type: 'integer', optional: false, nullable: false },
			updatedAt: { type: 'string', optional: false, nullable: false, format: 'date-time' },
			defaultSystemPrompt: { type: 'string', optional: false, nullable: false },
			// kyunet: feat/llm-translation - feat/image-translation
			imageEnabled: { type: 'boolean', optional: false, nullable: false },
			imageSystemPrompt: { type: 'string', optional: false, nullable: true },
			imageSeparateConnection: { type: 'boolean', optional: false, nullable: false },
			imageBaseUrl: { type: 'string', optional: false, nullable: true },
			imageApiKeySet: { type: 'boolean', optional: false, nullable: false },
			imageModel: { type: 'string', optional: false, nullable: true },
			imageExtraParams: { type: 'object', optional: false, nullable: false, additionalProperties: true },
			imageStructuredOutput: { type: 'boolean', optional: false, nullable: false },
			imageTimeoutMs: { type: 'integer', optional: false, nullable: false },
			imageMaxConcurrency: { type: 'integer', optional: false, nullable: false },
			imageMaxTokensParam: { type: 'string', optional: false, nullable: false, enum: ['max_completion_tokens', 'max_tokens'] },
			defaultImageSystemPrompt: { type: 'string', optional: false, nullable: false },
			stats: {
				type: 'object',
				optional: false, nullable: false,
				properties: {
					cacheRows: { type: 'integer', optional: false, nullable: false },
					gateSkipped: { type: 'integer', optional: false, nullable: false },
					cacheHits: { type: 'integer', optional: false, nullable: false },
					llmItems: { type: 'integer', optional: false, nullable: false },
					llmCalls: { type: 'integer', optional: false, nullable: false },
					llmFailures: { type: 'integer', optional: false, nullable: false },
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.meta)
		private serverSettings: MiMeta,

		private kyunetTranslationSettingService: KyunetTranslationSettingService,
		private kyunetTranslationService: KyunetTranslationService,
		private kyunetTranslationDeeplClient: KyunetTranslationDeeplClient,
	) {
		super(meta, paramDef, async () => {
			const { id: _id, updatedAt, ...pub } = this.kyunetTranslationSettingService.toPublic();
			const stats = await this.kyunetTranslationService.getStats();
			// arti: only whether the instance-wide DeepL key exists; the key itself never leaves the server
			const deeplAuthKeySet = this.serverSettings.deeplAuthKey != null && this.serverSettings.deeplAuthKey !== '';
			// arti: this month's DeepL usage (null when there is no key or DeepL could not be reached)
			const deeplUsage = deeplAuthKeySet ? await this.kyunetTranslationDeeplClient.usage() : null;
			return { ...pub, deeplAuthKeySet, deeplUsage, updatedAt: updatedAt.toISOString(), defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT, defaultImageSystemPrompt: DEFAULT_IMAGE_SYSTEM_PROMPT, stats };
		});
	}
}
