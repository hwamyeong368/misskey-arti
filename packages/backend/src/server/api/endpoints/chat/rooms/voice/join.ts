/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { ChatRoomMembershipsRepository } from '@/models/_.js';
import type { MiRemoteUser } from '@/models/User.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { RemoteVoiceCallService, RemoteVoiceCallError } from '@/core/RemoteVoiceCallService.js';
import { LiveKitService } from '@/core/LiveKitService.js';
import { RoleService } from '@/core/RoleService.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	limit: {
		duration: ms('1minute'),
		max: 30,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			url: {
				type: 'string',
				optional: false, nullable: false,
			},
			token: {
				type: 'string',
				optional: false, nullable: false,
			},
			// 通話を開くサーバーの TURN (設定されていなければ null)。ブラウザはこれを LiveKit が渡すものの代わりに使う
			iceServers: {
				type: 'array',
				optional: false, nullable: true,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						urls: {
							type: 'array',
							optional: false, nullable: false,
							items: {
								type: 'string',
								optional: false, nullable: false,
							},
						},
						username: {
							type: 'string',
							optional: true, nullable: false,
						},
						credential: {
							type: 'string',
							optional: true, nullable: false,
						},
					},
				},
			},
		},
	},

	errors: {
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: 'ddc7cfd6-56be-41b2-83c6-22ce4e45b52a',
		},
		voiceCallUnavailable: {
			message: 'Voice calls are not available.',
			code: 'VOICE_CALL_UNAVAILABLE',
			id: '6467d072-503a-4ed0-b3ed-36c10637d298',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId'],
} as const;

// arti: from choco (chalkpe/cherrypick). Only rooms of this server for now
@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatVoiceService: ChatVoiceService,
		private remoteVoiceCallService: RemoteVoiceCallService,
		private liveKitService: LiveKitService,
		private roleService: RoleService,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,
	) {
		super(meta, paramDef, async (ps, me) => {
			if (!this.liveKitService.isEnabled) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			// 参加すると話せるので、チャットの書き込み権限を要求する
			await this.chatService.checkChatAvailability(me.id, 'write');

			const [room, hasMembership] = await Promise.all([
				this.chatService.findRoomById(ps.roomId),
				this.chatRoomMembershipsRepository.exists({ where: { roomId: ps.roomId, userId: me.id } }),
			]);
			if (room == null || (room.ownerId !== me.id && !hasMembership)) {
				throw new ApiError(meta.errors.noSuchRoom);
			}

			// arti: a room hosted by another server runs its call there
			if (room.isArchived || me.isDeleted) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			const policies = await this.roleService.getUserPolicies(me.id);
			if (!policies.canVoiceCall) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			if (room.owner?.host != null) {
				try {
					return await this.remoteVoiceCallService.requestJoin(me, room, room.owner as MiRemoteUser, policies.canScreenShare);
				} catch (err) {
					if (err instanceof RemoteVoiceCallError) throw new ApiError(meta.errors.voiceCallUnavailable);
					throw err;
				}
			}

			return await this.chatVoiceService.issueJoinToken(me, room, policies.canScreenShare);
		});
	}
}
