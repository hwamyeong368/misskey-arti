/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/Meta.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import { bindThis } from '@/decorators.js';
import { reportedVoiceStatus } from '@/core/voice-participant-status.js';
import type Logger from '@/logger.js';
import { StatusError } from '@/misc/status-error.js';
import { MAX_ROOM_MEMBERS } from '@/core/ChatService.js';
import { ChatVoiceService, isRemoteVoiceCallEnabled } from '@/core/ChatVoiceService.js';
import type { JoinCredentials } from '@/core/ChatVoiceService.js';
import { HostPolicyService } from '@/core/HostPolicyService.js';
import { CloudflareTurnService, parseIceServers } from '@/core/CloudflareTurnService.js';
import type { IceServer } from '@/core/CloudflareTurnService.js';
import { ApRequestService } from '@/core/activitypub/ApRequestService.js';
import { chatRoomUri } from '@/core/activitypub/misc/chat-payloads.js';
import { LoggerService } from '@/core/LoggerService.js';

const TOKEN_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_RESPONSE_SIZE_LIMIT = 64 * 1024;
const UNSUPPORTED_HOST_TTL_SECONDS = 3600;

/**
 * arti: why joining a call on another server failed.
 * - unsupported: that server has no voice calls (404)
 * - forbidden: either server refused
 * - unreachable: the server could not be reached or answered nonsense
 */
export class RemoteVoiceCallError extends Error {
	constructor(public reason: 'unsupported' | 'forbidden' | 'unreachable') {
		super(`Cannot join the voice call on the remote host: ${reason}`);
		this.name = 'RemoteVoiceCallError';
	}
}

type TokenResponse = {
	url: string;
	token: string;
	iceServers: IceServer[] | null;
	participants: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean; recording?: boolean }[];
	updatedAt: number;
};

/**
 * arti: the way a user of this server joins a call in a room hosted by another
 * server. The call runs on the owner's server, so we ask it for a token signed
 * with the user's key.
 * Ported from choco (chalkpe/cherrypick).
 */
@Injectable()
export class RemoteVoiceCallService {
	private logger: Logger;

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.meta)
		private meta: MiMeta,

		private apRequestService: ApRequestService,
		private chatVoiceService: ChatVoiceService,
		private hostPolicyService: HostPolicyService,
		private cloudflareTurnService: CloudflareTurnService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('chat-voice');
	}

	/** Whether users of this server may join calls hosted elsewhere. */
	public get isEnabled(): boolean {
		return isRemoteVoiceCallEnabled(this.meta);
	}

	@bindThis
	public async requestJoin(me: MiLocalUser, room: MiChatRoom, owner: MiRemoteUser, canScreenShare: boolean): Promise<JoinCredentials> {
		const ownerUrl = await this.trustedOwnerUrlOf(owner);
		if (ownerUrl == null) throw new RemoteVoiceCallError('forbidden');

		await this.assertHostSupported(owner.host);

		const origin = ownerUrl.origin;

		let body: unknown;
		try {
			body = await this.apRequestService.signedPostJson(
				me,
				`${origin}/livekit/federation/token`,
				{ room: chatRoomUri(room, origin), canScreenShare },
				TOKEN_REQUEST_TIMEOUT_MS,
				{ redirect: 'manual', size: TOKEN_RESPONSE_SIZE_LIMIT },
			);
		} catch (err) {
			throw await this.errorOf(err, owner.host, true);
		}

		const response = parseTokenResponse(body, `${origin}/livekit`);
		if (response == null) throw new RemoteVoiceCallError('unreachable');

		this.chatVoiceService.storeRemoteSnapshot(room, response.participants, response.updatedAt).catch(err => {
			this.logger.warn(`Failed to store the voice call participants of ${room.id} sent by ${owner.host}`, { error: err });
		});

		const iceServers = response.iceServers ?? await this.cloudflareTurnService.getIceServers() ?? [];
		return { url: response.url, token: response.token, iceServers };
	}

	@bindThis
	public async reportStatus(me: MiLocalUser, room: MiChatRoom, owner: MiRemoteUser, sessionId: string, status: { micMuted: boolean; deafened: boolean; recording?: boolean }): Promise<void> {
		if (!this.isEnabled) throw new RemoteVoiceCallError('forbidden');
		const ownerUrl = await this.trustedOwnerUrlOf(owner);
		if (ownerUrl == null) throw new RemoteVoiceCallError('forbidden');
		await this.assertHostSupported(owner.host);
		try {
			await this.apRequestService.signedPostJson(me, `${ownerUrl.origin}/livekit/federation/status`, {
				room: chatRoomUri(room, ownerUrl.origin), sessionId, ...status,
			}, TOKEN_REQUEST_TIMEOUT_MS, { redirect: 'manual', size: TOKEN_RESPONSE_SIZE_LIMIT });
		} catch (err) {
			throw await this.errorOf(err, owner.host, false);
		}
	}

	private async assertHostSupported(host: string): Promise<void> {
		if (await this.redisClient.exists(unsupportedHostKeyOf(host))) throw new RemoteVoiceCallError('unsupported');
	}

	private async errorOf(err: unknown, host: string, rememberUnsupported: boolean): Promise<RemoteVoiceCallError> {
		if (err instanceof StatusError) {
			if (err.statusCode === 404) {
				if (rememberUnsupported) await this.redisClient.set(unsupportedHostKeyOf(host), '1', 'EX', UNSUPPORTED_HOST_TTL_SECONDS);
				return new RemoteVoiceCallError('unsupported');
			}
			if (err.statusCode === 401 || err.statusCode === 403) return new RemoteVoiceCallError('forbidden');
		}
		return new RemoteVoiceCallError('unreachable');
	}

	private async trustedOwnerUrlOf(owner: MiRemoteUser): Promise<URL | null> {
		if (owner.isSuspended || owner.isDeleted) return null;

		let ownerUrl: URL;
		try {
			ownerUrl = new URL(owner.uri);
		} catch {
			return null;
		}
		if (ownerUrl.host !== owner.host) return null;
		if (await this.hostPolicyService.isRefusedRemoteHost(owner.host)) return null;

		return ownerUrl;
	}
}

function unsupportedHostKeyOf(host: string): string {
	return `chatVoice:unsupportedHost:${host}`;
}

function parseTokenResponse(body: unknown, expectedUrl: string): TokenResponse | null {
	if (typeof body !== 'object' || body == null) return null;
	const { url, token, iceServers, participants, updatedAt } = body as Record<string, unknown>;

	if (url !== expectedUrl) return null;
	if (typeof token !== 'string' || token === '') return null;
	if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
	if (!Array.isArray(participants) || participants.length > MAX_ROOM_MEMBERS + 1) return null;

	const parsed: TokenResponse['participants'] = [];
	for (const participant of participants as unknown[]) {
		if (typeof participant !== 'object' || participant == null) return null;
		const { identity, screenSharing } = participant as Record<string, unknown>;
		if (typeof identity !== 'string' || typeof screenSharing !== 'boolean') return null;
		parsed.push({ identity, screenSharing, ...reportedVoiceStatus(participant as Record<string, unknown>) });
	}

	return { url: expectedUrl, token, iceServers: parseIceServers(iceServers), participants: parsed, updatedAt };
}
