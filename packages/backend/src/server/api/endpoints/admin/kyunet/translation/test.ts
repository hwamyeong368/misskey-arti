/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only admin endpoint: one-off translation of arbitrary text, bypassing cache and gate (spec 6.3).

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { KyunetTranslationService } from '@/core/KyunetTranslationService.js';

export const meta = {
	tags: ['admin', 'kyunet'],

	requireCredential: true,
	requireAdmin: true,
	kind: 'write:admin:meta',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			ok: { type: 'boolean', optional: false, nullable: false },
			latencyMs: { type: 'integer', optional: false, nullable: false },
			// text null with ok=true means "nothing to translate"
			text: { type: 'string', optional: false, nullable: true },
			sourceLangs: { type: 'array', optional: false, nullable: true, items: { type: 'string', optional: false, nullable: false } },
			error: { type: 'string', optional: false, nullable: true },
			raw: { type: 'string', optional: false, nullable: true },
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		text: { type: 'string', minLength: 1, maxLength: 10000 },
		targetLang: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$' },
	},
	required: ['text', 'targetLang'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private kyunetTranslationService: KyunetTranslationService,
	) {
		super(meta, paramDef, async (ps) => {
			const r = await this.kyunetTranslationService.testTranslate(ps.text, ps.targetLang);
			return {
				ok: r.ok,
				latencyMs: r.latencyMs,
				text: r.result?.text ?? null,
				sourceLangs: r.result?.sourceLangs ?? null,
				error: r.error ?? null,
				raw: r.raw === undefined ? null : JSON.stringify(r.raw, null, 2),
			};
		});
	}
}
