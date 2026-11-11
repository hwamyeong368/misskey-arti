/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only admin endpoint: update LLM translation settings (spec 6.2). apiKey: undefined keeps, '' deletes.

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { KyunetTranslationSettingService } from '@/core/KyunetTranslationSettingService.js';
import type { KyunetTranslationSettingPatch } from '@/core/KyunetTranslationSettingService.js';
import { ApiError } from '../../../../error.js';

export const meta = {
	tags: ['admin', 'kyunet'],

	requireCredential: true,
	requireAdmin: true,
	kind: 'write:admin:meta',

	errors: {
		invalidParam: {
			message: 'Invalid parameter.',
			code: 'INVALID_PARAM',
			id: '30444621-8916-461a-b462-cbe7cb06554f',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		enabled: { type: 'boolean' },
		provider: { type: 'string', enum: ['openai', 'deepl'] },
		fallbackEnabled: { type: 'boolean' },
		baseUrl: { type: 'string', maxLength: 1024, nullable: true },
		apiKey: { type: 'string', maxLength: 1024 },
		model: { type: 'string', maxLength: 256, nullable: true },
		extraParams: { type: 'object', additionalProperties: true },
		systemPrompt: { type: 'string', nullable: true, maxLength: 20000 },
		structuredOutput: { type: 'boolean' },
		timeoutMs: { type: 'integer', minimum: 1000, maximum: 600000 },
		maxConcurrency: { type: 'integer', minimum: 1, maximum: 256 },
		maxTokensParam: { type: 'string', enum: ['max_completion_tokens', 'max_tokens'] },
		maxInputLength: { type: 'integer', minimum: 1, maximum: 100000 },
		batchMaxChars: { type: 'integer', minimum: 1, maximum: 200000 },
		batchMaxItems: { type: 'integer', minimum: 1, maximum: 50 },
		heuristicGate: { type: 'boolean' },
		cacheRetentionDays: { type: 'integer', minimum: 0, maximum: 3650 },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private kyunetTranslationSettingService: KyunetTranslationSettingService,
	) {
		super(meta, paramDef, async (ps) => {
			if (ps.extraParams != null) {
				if (Array.isArray(ps.extraParams)) throw new ApiError(meta.errors.invalidParam, { reason: 'extraParams must be an object' });
				if ('messages' in ps.extraParams) throw new ApiError(meta.errors.invalidParam, { reason: 'extraParams.messages is reserved' });
			}
			// Pick only declared params: the request body also carries the credential `i`, which must not reach the update.
			const patch: KyunetTranslationSettingPatch = {};
			for (const key of Object.keys(paramDef.properties) as (keyof typeof paramDef.properties)[]) {
				if (ps[key] !== undefined) (patch as Record<string, unknown>)[key] = ps[key];
			}
			if (ps.baseUrl === '') patch.baseUrl = null;
			if (ps.model === '') patch.model = null;
			if (ps.systemPrompt === '') patch.systemPrompt = null;
			await this.kyunetTranslationSettingService.update(patch);
		});
	}
}
