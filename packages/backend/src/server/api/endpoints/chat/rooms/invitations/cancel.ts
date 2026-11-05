/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// arti: the room owner takes back an invitation; a remote invitee is told with an Undo (from CherryPick)

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { ChatService } from '@/core/ChatService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	errors: {
		noSuchInvitation: {
			message: 'No such invitation.',
			code: 'NO_SUCH_INVITATION',
			id: '24212992-e1f2-41cd-be26-019a88b1a235',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		invitationId: { type: 'string', format: 'misskey:id' },
	},
	required: ['invitationId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
	) {
		super(meta, paramDef, async (ps, me) => {
			await this.chatService.checkChatAvailability(me.id, 'write');

			const canceled = await this.chatService.cancelRoomInvitation(me.id, ps.invitationId);
			if (!canceled) {
				throw new ApiError(meta.errors.noSuchInvitation);
			}
		});
	}
}
