/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only admin endpoint: delete translation cache rows (all / by age / by model / by note) (spec 6.3).

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { KyunetTranslationService } from '@/core/KyunetTranslationService.js';
import { ApiError } from '../../../../error.js';

export const meta = {
	tags: ['admin', 'kyunet'],

	requireCredential: true,
	requireAdmin: true,
	kind: 'write:admin:meta',

	errors: {
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'bae079c5-1685-401d-96da-b312ca1439b7',
		},
		invalidParam: {
			message: 'Exactly one of all / olderThanDays / model / noteId is required.',
			code: 'INVALID_PARAM',
			id: '6911ba03-b8a0-47a7-b1f6-d4f6bdd90cec',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			deleted: { type: 'integer', optional: false, nullable: false },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		all: { type: 'boolean' },
		olderThanDays: { type: 'integer', minimum: 1, maximum: 3650 },
		model: { type: 'string', minLength: 1, maxLength: 256 },
		noteId: { type: 'string', format: 'misskey:id' },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private kyunetTranslationService: KyunetTranslationService,
	) {
		super(meta, paramDef, async (ps) => {
			const given = [ps.all === true, ps.olderThanDays != null, ps.model != null, ps.noteId != null].filter(Boolean).length;
			if (given !== 1) throw new ApiError(meta.errors.invalidParam);

			try {
				const deleted = ps.all === true ? await this.kyunetTranslationService.clearCache({ all: true })
					: ps.olderThanDays != null ? await this.kyunetTranslationService.clearCache({ olderThanDays: ps.olderThanDays })
					: ps.model != null ? await this.kyunetTranslationService.clearCache({ model: ps.model })
					: await this.kyunetTranslationService.clearCache({ noteId: ps.noteId! });
				return { deleted };
			} catch (err) {
				if (err instanceof Error && err.message === 'no such note') throw new ApiError(meta.errors.noSuchNote);
				throw err;
			}
		});
	}
}
