/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only LLM translation endpoint (spec 6.1). Clients send references, never text.

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { RoleService } from '@/core/RoleService.js';
import { KyunetTranslationSettingService } from '@/core/KyunetTranslationSettingService.js';
import { KyunetTranslationService } from '@/core/KyunetTranslationService.js';
import type { TranslationItemRef } from '@/core/KyunetTranslationService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['kyunet'],

	requireCredential: true,
	kind: 'read:account',

	limit: {
		duration: 1000 * 60,
		max: 120,
	},

	errors: {
		unavailable: {
			message: 'LLM translation is unavailable.',
			code: 'UNAVAILABLE',
			id: '0e489ac5-67aa-4022-b94c-d96592948ec6',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			items: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						status: { type: 'string', optional: false, nullable: false, enum: ['ok', 'unavailable', 'failed'] },
						text: { type: 'string', optional: false, nullable: true },
						sourceLangs: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		targetLang: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$' },
		force: { type: 'boolean', default: false },
		items: {
			type: 'array',
			minItems: 1,
			maxItems: 50,
			items: {
				type: 'object',
				properties: {
					type: { type: 'string', enum: ['note', 'user_name', 'user_description', 'user_field_name', 'user_field_value'] },
					id: { type: 'string', format: 'misskey:id' },
					index: { type: 'integer', minimum: 0, maximum: 64 },
				},
				required: ['type', 'id'],
			},
		},
	},
	required: ['targetLang', 'items'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private roleService: RoleService,
		private kyunetTranslationSettingService: KyunetTranslationSettingService,
		private kyunetTranslationService: KyunetTranslationService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const policies = await this.roleService.getUserPolicies(me.id);
			if (!policies.canUseTranslator || !this.kyunetTranslationSettingService.isAvailable()) {
				throw new ApiError(meta.errors.unavailable);
			}

			// field kinds without an index resolve to `unavailable` inside the service (index becomes NaN)
			const refs = ps.items.map(item => ({ type: item.type, id: item.id, index: item.index ?? Number.NaN }) as TranslationItemRef);
			const items = await this.kyunetTranslationService.translate(refs, ps.targetLang, me, { force: ps.force });
			return { items };
		});
	}
}
