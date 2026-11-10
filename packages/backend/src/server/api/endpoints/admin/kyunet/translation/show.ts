/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only admin endpoint: current LLM translation settings (apiKey redacted) + stats (spec 6.2).

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { KyunetTranslationSettingService } from '@/core/KyunetTranslationSettingService.js';
import { KyunetTranslationService } from '@/core/KyunetTranslationService.js';
import { DEFAULT_SYSTEM_PROMPT } from '@/core/KyunetTranslationLlmClient.js';

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
		private kyunetTranslationSettingService: KyunetTranslationSettingService,
		private kyunetTranslationService: KyunetTranslationService,
	) {
		super(meta, paramDef, async () => {
			const { id: _id, updatedAt, ...pub } = this.kyunetTranslationSettingService.toPublic();
			const stats = await this.kyunetTranslationService.getStats();
			return { ...pub, updatedAt: updatedAt.toISOString(), defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT, stats };
		});
	}
}
