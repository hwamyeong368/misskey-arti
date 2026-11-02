/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// arti: copy a decoration that a remote user wears into this server's own decorations.
// Idea from CherryPick's admin/avatar-decorations/copy. bscone keeps remote decorations on the user
// (RemoteAvatarDecorationService) instead of a table, so we pick it by user + decoration id.

import { Inject, Injectable } from '@nestjs/common';
import type { UsersRepository } from '@/models/_.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import { DriveService } from '@/core/DriveService.js';
import { IdService } from '@/core/IdService.js';
import { ApiError } from '../../../error.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requiredRolePolicy: 'canManageAvatarDecorations',
	kind: 'write:admin:avatar-decorations',

	errors: {
		noSuchUser: {
			message: 'No such remote user.',
			code: 'NO_SUCH_USER',
			id: '3c1b9f2e-6a47-4d0b-9a55-7f0e2b8c1d41',
		},
		noSuchDecoration: {
			message: 'The user does not wear that decoration.',
			code: 'NO_SUCH_DECORATION',
			id: '8e5a0d77-2f3c-4b9e-a1d6-4c2f9b7e0a53',
		},
		failedToDownload: {
			message: 'Failed to download the decoration image.',
			code: 'FAILED_TO_DOWNLOAD',
			id: 'b7d2c4e1-9f08-4a6b-8e3d-1a5c7f2b9e64',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			id: {
				type: 'string',
				optional: false, nullable: false,
				format: 'id',
			},
			createdAt: {
				type: 'string',
				optional: false, nullable: false,
				format: 'date-time',
			},
			updatedAt: {
				type: 'string',
				optional: false, nullable: true,
				format: 'date-time',
			},
			name: {
				type: 'string',
				optional: false, nullable: false,
			},
			description: {
				type: 'string',
				optional: false, nullable: false,
			},
			url: {
				type: 'string',
				optional: false, nullable: false,
			},
			roleIdsThatCanBeUsedThisDecoration: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'string',
					optional: false, nullable: false,
					format: 'id',
				},
			},
			category: {
				type: 'string',
				optional: false, nullable: true,
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		userId: { type: 'string', format: 'misskey:id' },
		decorationId: { type: 'string', minLength: 1, maxLength: 256 },
		name: { type: 'string', minLength: 1 },
		description: { type: 'string' },
		category: { type: 'string', nullable: true },
	},
	required: ['userId', 'decorationId', 'name'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private avatarDecorationService: AvatarDecorationService,
		private driveService: DriveService,
		private idService: IdService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const user = await this.usersRepository.findOneBy({ id: ps.userId });
			if (user == null || user.host == null) throw new ApiError(meta.errors.noSuchUser);

			// only decorations the remote server reported for this user (raw url as stored by RemoteAvatarDecorationService)
			const decoration = user.avatarDecorations.find(d => d.id === ps.decorationId);
			if (decoration?.url == null) throw new ApiError(meta.errors.noSuchDecoration);

			let driveFile: MiDriveFile;
			try {
				driveFile = await this.driveService.uploadFromUrl({ url: decoration.url, user: null, force: true });
			} catch {
				throw new ApiError(meta.errors.failedToDownload);
			}

			const created = await this.avatarDecorationService.create({
				name: ps.name,
				description: ps.description ?? '',
				url: driveFile.url,
				category: ps.category ?? null,
			}, me);

			return {
				id: created.id,
				createdAt: this.idService.parse(created.id).date.toISOString(),
				updatedAt: null,
				name: created.name,
				description: created.description,
				url: created.url,
				roleIdsThatCanBeUsedThisDecoration: created.roleIdsThatCanBeUsedThisDecoration,
				category: created.category,
			};
		});
	}
}
