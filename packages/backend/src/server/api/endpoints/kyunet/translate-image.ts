/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: feat/llm-translation - feat/image-translation
// One image per request: a vision call is slow, so it stays out of kyunet/translate's batching queue.
// noteId is the access check: the file must be attached to a note the requester can see.

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { RoleService } from '@/core/RoleService.js';
import { KyunetTranslationSettingService } from '@/core/KyunetTranslationSettingService.js';
import { KyunetTranslationService } from '@/core/KyunetTranslationService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['kyunet'],

	requireCredential: true,
	kind: 'read:account',

	limit: {
		duration: 1000 * 60,
		max: 30,
	},

	errors: {
		unavailable: {
			message: 'LLM image translation is unavailable.',
			code: 'UNAVAILABLE',
			id: '6f7c2a0e-5d5b-4a3f-9a52-3a8f6a1d2b4e',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			status: { type: 'string', optional: false, nullable: false, enum: ['ok', 'unavailable', 'failed'] },
			// null with status ok means the image has no text to translate
			text: { type: 'string', optional: false, nullable: true },
			sourceLangs: { type: 'array', optional: false, nullable: false, items: { type: 'string', optional: false, nullable: false } },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		fileId: { type: 'string', format: 'misskey:id' },
		noteId: { type: 'string', format: 'misskey:id' },
		targetLang: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$' },
		force: { type: 'boolean', default: false },
	},
	required: ['fileId', 'noteId', 'targetLang'],
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
			if (!policies.canUseTranslator || !this.kyunetTranslationSettingService.isImageAvailable()) {
				throw new ApiError(meta.errors.unavailable);
			}
			const r = await this.kyunetTranslationService.translateImage(ps.fileId, ps.noteId, ps.targetLang, me, { force: ps.force });
			return { status: r.status, text: r.text, sourceLangs: [...r.sourceLangs] };
		});
	}
}
