/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/*
 * arti: voice calls in chat rooms, ported from choco (chalkpe/cherrypick).
 * This first step only covers calls among users of this server: the parts of choco's
 * ChatVoiceService that talk to other servers (mirror rooms, snapshots over ActivityPub,
 * Cloudflare TURN) are left out and every remote participant is refused.
 */

import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, IsNull } from 'typeorm';
import type { WebhookEvent } from 'livekit-server-sdk';
import { DI } from '@/di-symbols.js';
import type { ChatRoomMembershipsRepository, ChatRoomsRepository, UsersRepository } from '@/models/_.js';
import type { MiChatRoom } from '@/models/ChatRoom.js';
import type { MiMeta } from '@/models/Meta.js';
import type { MiLocalUser, MiRemoteUser, MiUser } from '@/models/User.js';
import type { Packed } from '@/misc/json-schema.js';
import { bindThis } from '@/decorators.js';
import { reportedVoiceStatus } from '@/core/voice-participant-status.js';
import type Logger from '@/logger.js';
import { MAX_ROOM_MEMBERS } from '@/core/ChatService.js';
import { LiveKitService, userIdOfMetadata } from '@/core/LiveKitService.js';
import type { LiveKitParticipant } from '@/core/LiveKitService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { RoleService } from '@/core/RoleService.js';
import type { RolePolicies } from '@/core/RoleService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { HostPolicyService } from '@/core/HostPolicyService.js';
import { QueueService } from '@/core/QueueService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import type { IObject } from '@/core/activitypub/type.js';
import { parseChatRoomVoiceState } from '@/core/activitypub/misc/chat-room-voice-state.js';
import type { IceServer } from '@/core/CloudflareTurnService.js';

const REFRESH_DELAY_MS = 500;

/** arti: whether this server lets its users join voice calls hosted by other servers (stage 2) */
export function isRemoteVoiceCallEnabled(meta: Pick<MiMeta, 'enableRemoteVoiceCall' | 'federation'>): boolean {
	return meta.enableRemoteVoiceCall && meta.federation !== 'none';
}

// LiveKit が再起動して room_finished を送らなかった場合でも表示が残らないよう、
// スナップショットには寿命を付け、通話中のルームは定期的に読み直す。
// 読み直すたびに、いまルームに残れない参加者 (メンバーでなくなった、停止された) も外す
const SNAPSHOT_TTL_SECONDS = 120;
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_LOCK_SECONDS = 50;
const ACTIVE_ROOMS_KEY = 'chatVoice:active';

// 現況の時刻 (増える一方) を覚えておく長さ。現況の寿命とワーカーの時計のずれより十分長くする
const LOCAL_STAMP_TTL_SECONDS = 3_600;

// 前の時刻より必ず後の時刻を決めて返す。どのワーカーの時計で決めても、後に決めた時刻は前のものより後になる。
// KEYS[1]: 時刻の鍵、ARGV: この時計の時刻、寿命 (秒)
const ALLOCATE_STAMP_SCRIPT = `
local stamp = tonumber(ARGV[1])
local last = tonumber(redis.call('GET', KEYS[1]))
if last and last + 1 > stamp then
	stamp = last + 1
end
redis.call('SET', KEYS[1], string.format('%.0f', stamp), 'EX', ARGV[2])
return stamp
`;

// 現況を、保存済みのものより新しい (updatedAt が大きい) ときだけ書き、通話中のルームの一覧も合わせて変える。書いたら 1。
// 遅れて読み終えた古い現況が新しい現況や一覧を戻さないようにする。空の現況 (通話の終わり) も時刻ごと残す。
// KEYS[1]: 現況の鍵、KEYS[2]: 通話中のルームの一覧、ARGV: 現況 (JSON)、その updatedAt、寿命 (秒)、ルームの id、空なら '1'
const STORE_LOCAL_SNAPSHOT_IF_NEWER_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
	local ok, stored = pcall(cjson.decode, current)
	if ok and type(stored) == 'table' and type(stored.updatedAt) == 'number' and stored.updatedAt >= tonumber(ARGV[2]) then
		return 0
	end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
if ARGV[5] == '1' then
	redis.call('SREM', KEYS[2], ARGV[4])
else
	redis.call('SADD', KEYS[2], ARGV[4])
end
return 1
`;

// 入った直後の参加者が残れるかを、読めないものがあって決められなかったとき、確かめ直すまで待つ長さ
const JOIN_RECHECK_DELAY_MS = 2_000;

// 定期的な読み直しで、残れるかを続けてこの回数決められなかった参加者を外す
const UNVERIFIED_SWEEP_LIMIT = 3;
const UNVERIFIED_TTL_SECONDS = 300;
const COUNT_UNVERIFIED_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[1])
return count
`;

// 参加者の出入りや画面共有の開始・終了に関わるイベントだけを扱う
const REFRESH_EVENTS = new Set([
	'room_started',
	'room_finished',
	'participant_joined',
	'participant_left',
	'participant_connection_aborted',
	'track_published',
	'track_unpublished',
]);

type VoiceSnapshot = {
	participants: { identity: string; userId: MiUser['id']; screenSharing: boolean; micMuted?: boolean; deafened?: boolean; recording?: boolean }[];
	updatedAt: number;
};

/** 通話の参加者。userId はトークンに付けたメタデータの値 (無ければ null) */
type CallParticipant = { identity: string; userId: MiUser['id'] | null; canScreenShare?: boolean; screenSharing?: boolean };
type NamedCallParticipant = CallParticipant & { userId: MiUser['id'] };

type Read<T> = { ok: true; value: T } | { ok: false; error: unknown };

type AdmissionContext = {
	room: Read<MiChatRoom | null>;
	users: Read<Map<MiUser['id'], MiUser>>;
	memberIds: Read<Set<MiUser['id']>>;
	policies: Map<MiUser['id'], Read<RolePolicies>>;
	/** arti: whether each remote participant's server is refused (blocked, suspended, not federated). Missing = could not decide */
	refusedHosts: Map<string, boolean>;
	errors: unknown[];
};

/**
 * - admitted: 残れる
 * - denied: 残れない (読めたものだけで決まる)
 * - unverified: 読めなかったものがあり、決められない
 */
type Admission = 'admitted' | 'denied' | 'unverified';

/**
 * - join: 入った直後。JOIN_RECHECK_DELAY_MS 後に一度だけ確かめ直し、それでも決められなければ外す
 * - sweep: 定期的な読み直し。続けて UNVERIFIED_SWEEP_LIMIT 回決められなければ外す
 */
type AdmissionCheck = 'join' | 'sweep';

/** 通話に入るためのもの。iceServers は TURN を使わないとき null */
export type JoinCredentials = {
	url: string;
	token: string;
	iceServers: IceServer[] | null;
};

/**
 * チャットルームの通話参加者のスナップショットを Redis に保持し、ストリームへ配信する。
 */
@Injectable()
export class ChatVoiceService implements OnModuleInit, OnApplicationShutdown {
	private pendingRefreshes = new Map<MiChatRoom['id'], { timer: NodeJS.Timeout; dueAt: number }>();
	private sweepTimer: NodeJS.Timeout | null = null;
	private pendingWaits = new Map<NodeJS.Timeout, (completed: boolean) => void>();
	private isShuttingDown = false;
	private logger: Logger;

	constructor(
		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.meta)
		private meta: MiMeta,

		private liveKitService: LiveKitService,
		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
		private roleService: RoleService,
		private hostPolicyService: HostPolicyService,
		private queueService: QueueService,
		private apRendererService: ApRendererService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('chat-voice');
	}

	/**
	 * 通話のトークンを発行する
	 */
	@bindThis
	public async issueJoinToken(user: MiLocalUser, room: MiChatRoom, canScreenShare: boolean): Promise<JoinCredentials> {
		await this.liveKitService.ensureRoom(room.id, MAX_ROOM_MEMBERS + 1);
		const token = await this.liveKitService.createJoinToken({
			roomId: room.id,
			identity: this.liveKitService.identityOf(user),
			userId: user.id,
			canScreenShare,
		});
		return { url: this.liveKitService.getPublicUrl(), token, iceServers: null };
	}

	/**
	 * arti: issue a join token to a user of another server for a room hosted here.
	 * Returns 'forbidden' for any room-level refusal so the caller cannot learn
	 * whether the room exists.
	 */
	@bindThis
	public async issueRemoteJoinToken(user: MiRemoteUser, roomId: MiChatRoom['id'], canScreenShareRequested: boolean): Promise<(JoinCredentials & { participants: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean; recording?: boolean }[]; updatedAt: number }) | 'forbidden'> {
		if (!this.liveKitService.isEnabled || !isRemoteVoiceCallEnabled(this.meta)) return 'forbidden';
		if (user.host == null) return 'forbidden';

		// Read everything before deciding, so the answer and its timing do not reveal whether the room exists
		const [room, isMember, isRefusedHost, policies] = await Promise.all([
			this.chatRoomsRepository.findOne({ where: { id: roomId }, relations: { owner: true } }),
			this.chatRoomMembershipsRepository.exists({ where: { roomId, userId: user.id } }),
			this.hostPolicyService.isRefusedRemoteHost(user.host),
			this.roleService.getUserPolicies(user.id),
		]);

		if (room == null || room.isArchived || room.owner == null || room.owner.host != null) return 'forbidden';
		if (user.isSuspended || user.isDeleted) return 'forbidden';
		if (isRefusedHost) return 'forbidden';
		if (!isMember) return 'forbidden';
		if (!policies.canVoiceCall || policies.chatAvailability !== 'available') return 'forbidden';

		await this.liveKitService.ensureRoom(room.id, MAX_ROOM_MEMBERS + 1);
		const token = await this.liveKitService.createJoinToken({
			roomId: room.id,
			identity: this.liveKitService.identityOf(user),
			userId: user.id,
			canScreenShare: canScreenShareRequested && policies.canScreenShare,
		});
		const snapshot = await this.snapshotOf(room.id);
		return { url: this.liveKitService.getPublicUrl(), token, iceServers: null, participants: snapshot.participants, updatedAt: snapshot.updatedAt };
	}

	/** Current participant snapshot of a room hosted here, for a remote server. */
	@bindThis
	public async snapshotOf(roomId: MiChatRoom['id']): Promise<{ participants: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean; recording?: boolean }[]; updatedAt: number }> {
		const raw = await this.redisClient.get(this.keyOf(roomId));
		if (raw == null) return { participants: [], updatedAt: Date.now() };
		const snapshot = JSON.parse(raw) as VoiceSnapshot;
		return {
			participants: snapshot.participants.map(p => ({ identity: p.identity, screenSharing: p.screenSharing, ...reportedVoiceStatus(p) })),
			updatedAt: snapshot.updatedAt,
		};
	}

	/** arti: remember the participants of a call hosted by another server. Older snapshots are ignored. */
	@bindThis
	public async storeRemoteSnapshot(room: MiChatRoom, participants: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean; recording?: boolean }[], updatedAt: number): Promise<'stored' | 'stale'> {
		const key = `chatVoice:remote:${room.id}`;
		const raw = await this.redisClient.get(key);
		if (raw != null) {
			try {
				const previous = JSON.parse(raw) as { updatedAt?: unknown };
				if (typeof previous.updatedAt === 'number' && previous.updatedAt >= updatedAt) return 'stale';
			} catch { /* overwrite broken state */ }
		}
		await this.redisClient.set(key, JSON.stringify({ participants, updatedAt }), 'EX', 600);
		return 'stored';
	}

	/** 認証したユーザー本人の、接続中のセッションの設定 (マイク・スピーカー) だけを受け付ける */
	@bindThis
	public async reportStatus(user: MiUser, roomId: string, sessionId: string, status: { micMuted: boolean; deafened: boolean; recording?: boolean }): Promise<boolean> {
		if (!this.liveKitService.isEnabled) return false;
		const participant = { identity: this.liveKitService.identityOf(user), userId: user.id };
		const context = await this.admissionContextOf(roomId, [participant]);
		const admission = this.admissionOf(participant, context);
		// 読めなかったものがあれば内部エラーにする。断ったと答えるとクライアントは送り直さず、設定が古いまま残るため
		if (admission === 'unverified' || context.errors.length > 0 || !context.room.ok) {
			throw new AggregateError(context.errors, `Failed to read what decides who may report the voice call settings in ${roomId}`);
		}
		if (admission === 'denied' || context.room.value == null) return false;
		// 録画はルームの持ち主が許したときだけ。既定では許さない
		if (status.recording === true && !context.room.value.allowRecording) return false;
		if (!await this.liveKitService.setParticipantStatus(roomId, participant.identity, sessionId, status)) return false;
		this.scheduleRefresh(roomId);
		return true;
	}

	/**
	 * 通話に入った参加者が、いまもそのルームに残れるか確かめ、残れなければ外す。
	 * トークンは 10 分有効なので、ルームを抜けた後でも同じトークンで入り直せてしまうため
	 */
	@bindThis
	public async removeUnadmittedParticipant(roomId: MiChatRoom['id'], participant: { identity: string; metadata?: string }): Promise<void> {
		await this.removeUnadmitted(roomId, [{ identity: participant.identity, userId: userIdOfMetadata(participant.metadata) }], 'join');
	}

	@bindThis
	public async getStates(me: { id: MiUser['id'] }, roomIds: MiChatRoom['id'][]): Promise<Packed<'ChatRoomVoiceState'>[]> {
		if (roomIds.length === 0) return [];
		const raws = await this.redisClient.mget(...roomIds.map(roomId => this.keyOf(roomId)));
		const remoteRaws = await this.redisClient.mget(...roomIds.map(roomId => `chatVoice:remote:${roomId}`));
		const states: Packed<'ChatRoomVoiceState'>[] = [];
		for (let i = 0; i < roomIds.length; i++) {
			const raw = raws[i];
			if (raw == null) {
				// arti: a room hosted by another server has no local snapshot; use the one its owner sent
				const remoteRaw = remoteRaws[i];
				if (remoteRaw == null) continue;
				const remote = JSON.parse(remoteRaw) as { participants: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean; recording?: boolean }[]; updatedAt: number };
				if (remote.participants.length === 0) continue;
				states.push(await this.packRemote(roomIds[i], remote, me));
				continue;
			}
			const snapshot = JSON.parse(raw) as VoiceSnapshot;
			if (snapshot.participants.length === 0) continue;
			states.push(await this.pack(roomIds[i], snapshot, me));
		}
		return states;
	}

	/** arti: pack a snapshot received from the server that hosts the room. */
	private async packRemote(roomId: MiChatRoom['id'], snapshot: { participants: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean; recording?: boolean }[]; updatedAt: number }, me: { id: MiUser['id'] } | null): Promise<Packed<'ChatRoomVoiceState'>> {
		const users = await this.usersRepository.findBy({ uri: In(snapshot.participants.map(p => p.identity)) });
		const userIdByIdentity = new Map(users.map(user => [user.uri, user.id]));
		const packedUsers = await this.userEntityService.packMany([...new Set(userIdByIdentity.values())], me);
		const userById = new Map(packedUsers.map(user => [user.id, user]));
		const participants: Packed<'ChatRoomVoiceState'>['participants'] = [];
		for (const p of snapshot.participants) {
			const userId = userIdByIdentity.get(p.identity);
			const user = userId != null ? userById.get(userId) : undefined;
			if (user == null) continue;
			participants.push({ identity: p.identity, user, screenSharing: p.screenSharing, ...reportedVoiceStatus(p) });
		}
		return { roomId, participants, updatedAt: snapshot.updatedAt };
	}

	@bindThis
	public handleWebhook(event: WebhookEvent): void {
		if (!REFRESH_EVENTS.has(event.event)) return;
		const roomName = event.room?.name;
		if (roomName == null) return;
		const roomId = this.liveKitService.roomIdOf(roomName);
		if (roomId == null) return;

		const participant = event.participant;
		if (event.event === 'participant_joined' && participant != null) {
			this.removeUnadmittedParticipant(roomId, participant).catch(() => {});
		}

		this.scheduleRefresh(roomId);
	}

	/**
	 * ルームを少し後に読み直す。ルームごとに一つにまとめる
	 */
	@bindThis
	public scheduleRefresh(roomId: MiChatRoom['id']): void {
		if (this.isShuttingDown) return;
		const dueAt = Date.now() + REFRESH_DELAY_MS;
		const scheduled = this.pendingRefreshes.get(roomId);
		if (scheduled != null) {
			if (scheduled.dueAt <= dueAt) return;
			clearTimeout(scheduled.timer);
		}
		const timer = setTimeout(() => {
			this.pendingRefreshes.delete(roomId);
			this.refresh(roomId).catch(err => this.logRefreshFailure(roomId, err));
		}, REFRESH_DELAY_MS);
		this.pendingRefreshes.set(roomId, { timer, dueAt });
	}

	/**
	 * ルームの参加者を LiveKit から読み直して保存し、メンバーに知らせる。
	 * sweep が true なら (定期的な読み直し)、読んだ参加者のうちいまそのルームに残れない者を外し、外せた者を除いて保存する
	 */
	@bindThis
	public async refresh(roomId: MiChatRoom['id'], sweep = false): Promise<void> {
		// 現況の時刻は、LiveKit を読み始める前に Redis で決める。読むのに手間取った現況が、後から読み始めた現況より新しく見えないように
		const readAt = Number(await this.redisClient.eval(ALLOCATE_STAMP_SCRIPT, 1, this.localStampKeyOf(roomId), Date.now(), LOCAL_STAMP_TTL_SECONDS));
		await this.redisClient.sadd(ACTIVE_ROOMS_KEY, roomId);
		const listed = await this.liveKitService.listParticipants(roomId);
		const removed = sweep ? await this.removeUnadmitted(roomId, listed, 'sweep') : new Set<string>();
		const participants = listed.filter(p => !removed.has(p.identity));
		const snapshot: VoiceSnapshot = {
			participants: participants.map(p => ({ identity: p.identity, userId: p.userId, screenSharing: p.screenSharing, ...reportedVoiceStatus(p) })),
			updatedAt: readAt,
		};

		const stored = await this.redisClient.eval(
			STORE_LOCAL_SNAPSHOT_IF_NEWER_SCRIPT,
			2,
			this.keyOf(roomId),
			ACTIVE_ROOMS_KEY,
			JSON.stringify(snapshot),
			snapshot.updatedAt,
			SNAPSHOT_TTL_SECONDS,
			roomId,
			snapshot.participants.length === 0 ? '1' : '0',
		) === 1;
		if (!stored) return;

		const room = await this.chatRoomsRepository.findOneBy({ id: roomId });
		if (room == null) return;

		// 通話の参加者はルームの今のメンバーにだけ知らせる。ルームのストリーム (chatRoom) はメンバーでないモデレーターも購読でき、
		// 抜けたメンバーの購読も続くので使わない
		const packed = await this.pack(roomId, snapshot, null);
		for (const userId of await this.localAudienceOf(room)) {
			this.globalEventService.publishMainStream(userId, 'chatRoomVoiceState', packed);
		}

		// arti: tell the members on other servers too, so their list changes without rejoining
		await this.deliverSnapshotToRemoteMembers(room, snapshot).catch(err => {
			this.logger.warn(`Failed to deliver the voice state of ${roomId} to other servers: ${err}`);
		});
	}

	/** arti: the last snapshot delivered to other servers, to skip unchanged ones */
	private readonly lastDelivered = new Map<string, { hash: string; at: number }>();

	private async deliverSnapshotToRemoteMembers(room: MiChatRoom, snapshot: VoiceSnapshot): Promise<void> {
		if (!isRemoteVoiceCallEnabled(this.meta)) return;

		const hash = JSON.stringify(snapshot.participants.map(p => [p.identity, p.screenSharing, p.micMuted, p.deafened, p.recording]));
		const now = Date.now();
		const last = this.lastDelivered.get(room.id);
		if (last != null && last.hash === hash && now - last.at < 30_000) return;

		const owner = await this.usersRepository.findOneBy({ id: room.ownerId });
		if (owner == null || owner.host != null) return;

		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const members = await this.usersRepository.find({
			where: { id: In(memberships.map(m => m.userId)) },
			select: { id: true, host: true, inbox: true, sharedInbox: true },
		});
		const inboxes = new Map<string, boolean>();
		for (const member of members) {
			if (member.host == null) continue;
			if (member.inbox != null) inboxes.set(member.inbox, false);
			if (member.sharedInbox != null) inboxes.set(member.sharedInbox, true);
		}
		if (inboxes.size === 0) return;

		const activity = this.apRendererService.addContext({
			type: 'Update',
			actor: this.userEntityService.genLocalUserUri(owner.id),
			object: this.apRendererService.renderChatRoomVoiceState(room, snapshot.participants, snapshot.updatedAt),
			published: new Date(snapshot.updatedAt).toISOString(),
		});
		await Promise.all([...inboxes].map(([inbox, isShared]) => this.queueService.deliver(owner, activity, inbox, isShared)));
		this.lastDelivered.set(room.id, { hash, at: now });
	}

	/** arti: a snapshot arrived from the owner of a mirror room */
	@bindThis
	public async receiveRemoteSnapshot(actor: MiRemoteUser, object: IObject): Promise<string> {
		if (!isRemoteVoiceCallEnabled(this.meta)) return 'skip: remote voice calls are disabled';

		const parsed = parseChatRoomVoiceState(actor.uri, object, MAX_ROOM_MEMBERS + 1);
		if (!parsed.ok) return `skip: ${parsed.reason}`;
		const { roomUri, roomId, participants, updatedAt } = parsed.state;

		// ルームの番号はそのサーバーの中でしか一意でないので URI で探す。URI を持たないのは、id が番号のままの古いミラー
		const room = await this.chatRoomsRepository.findOne({ where: { uri: roomUri }, relations: { owner: true } })
			?? await this.chatRoomsRepository.findOne({ where: { id: roomId, uri: IsNull() }, relations: { owner: true } });
		if (room == null) return 'skip: unknown room';
		if (room.ownerId !== actor.id) return 'skip: sender does not own the room';

		const stored = await this.storeRemoteSnapshot(room, participants, updatedAt);
		if (stored !== 'stored') return 'skip: voice state is not newer than the last one';

		const packed = await this.packRemote(room.id, { participants, updatedAt }, null);
		for (const userId of await this.localAudienceOf(room)) {
			this.globalEventService.publishMainStream(userId, 'chatRoomVoiceState', packed);
		}
		return 'ok: voice state stored';
	}

	/**
	 * 通話中のルームを読み直す。ルームごとに一つのワーカーだけが読み直す
	 */
	@bindThis
	public async sweep(): Promise<void> {
		const roomIds = await this.redisClient.smembers(ACTIVE_ROOMS_KEY);
		for (const roomId of roomIds) {
			const locked = await this.redisClient.set(`chatVoice:sweep:${roomId}`, '1', 'EX', SWEEP_LOCK_SECONDS, 'NX');
			if (locked !== 'OK') continue;
			await this.refresh(roomId, true).catch(err => {
				// LiveKit に届かなければスナップショットの寿命切れに任せる
				this.logRefreshFailure(roomId, err);
			});
		}
	}

	@bindThis
	public onModuleInit(): void {
		if (!this.liveKitService.isEnabled) return;
		this.sweepTimer = setInterval(() => {
			this.sweep().catch(() => {});
		}, SWEEP_INTERVAL_MS);
	}

	@bindThis
	public onApplicationShutdown(): void {
		for (const { timer } of this.pendingRefreshes.values()) clearTimeout(timer);
		this.pendingRefreshes.clear();
		this.isShuttingDown = true;
		for (const [timer, resolve] of this.pendingWaits) {
			clearTimeout(timer);
			resolve(false);
		}
		this.pendingWaits.clear();
		if (this.sweepTimer != null) clearInterval(this.sweepTimer);
		this.sweepTimer = null;
	}

	private keyOf(roomId: MiChatRoom['id']): string {
		return `chatVoice:state:${roomId}`;
	}

	private localStampKeyOf(roomId: MiChatRoom['id']): string {
		return `chatVoice:localStamp:${roomId}`;
	}

	private logRefreshFailure(roomId: MiChatRoom['id'], err: unknown): void {
		this.logger.warn(`Failed to refresh the voice call in ${roomId}: ${err instanceof Error ? err.message : String(err)}`);
	}

	/**
	 * 参加者のうち、いまそのルームに残れないものを外し、外せた参加者の identity を返す。
	 * トークンにユーザーの無い参加者は、何も読まずに外す
	 */
	private async removeUnadmitted(roomId: MiChatRoom['id'], participants: CallParticipant[], check: AdmissionCheck): Promise<Set<string>> {
		const denied: string[] = [];
		const named: NamedCallParticipant[] = [];
		for (const participant of participants) {
			if (participant.userId == null) denied.push(participant.identity);
			else named.push({ ...participant, userId: participant.userId });
		}

		const decision = named.length > 0 ? await this.admissionsOf(roomId, named) : { admitted: [], denied: [], unverified: [] };
		denied.push(...decision.denied);
		const removed = await this.removeParticipants(roomId, denied);

		let giveUp: string[] = [];
		if (decision.unverified.length > 0) {
			const identities = decision.unverified.map(p => p.identity);
			if (check === 'join') {
				this.logger.warn(`Could not check whether ${identities.join(', ')} may stay in the voice call in ${roomId}; checking again in ${JOIN_RECHECK_DELAY_MS / 1000} seconds`);
				giveUp = await this.recheckJoined(roomId, decision.unverified);
			} else {
				giveUp = await this.countUnverified(roomId, identities);
			}
			for (const identity of await this.removeParticipants(roomId, giveUp)) removed.add(identity);
		}

		await this.forgetUnverified(roomId, [...decision.admitted, ...decision.denied, ...giveUp]);
		return removed;
	}

	private async removeParticipants(roomId: MiChatRoom['id'], identities: string[]): Promise<Set<string>> {
		const removed = new Set<string>();
		for (const identity of identities) {
			try {
				await this.liveKitService.removeParticipant(roomId, identity);
				removed.add(identity);
			} catch (err) {
				this.logger.warn(`Failed to remove ${identity}, who may not stay, from the voice call in ${roomId}`, { error: err });
			}
		}
		return removed;
	}

	private async admissionsOf(roomId: MiChatRoom['id'], participants: NamedCallParticipant[]): Promise<{ admitted: string[]; denied: string[]; unverified: NamedCallParticipant[] }> {
		const context = await this.admissionContextOf(roomId, participants);
		const result = { admitted: [] as string[], denied: [] as string[], unverified: [] as NamedCallParticipant[] };
		for (const participant of participants) {
			switch (this.admissionOf(participant, context)) {
				case 'admitted': result.admitted.push(participant.identity); break;
				case 'denied': result.denied.push(participant.identity); break;
				case 'unverified': result.unverified.push(participant); break;
			}
		}
		if (result.unverified.length > 0) {
			this.logger.warn(`Failed to read what decides who may stay in the voice call in ${roomId}`, { error: context.errors[0] });
		}
		return result;
	}

	private async recheckJoined(roomId: MiChatRoom['id'], participants: NamedCallParticipant[]): Promise<string[]> {
		if (!(await this.wait(JOIN_RECHECK_DELAY_MS))) return [];
		const decision = await this.admissionsOf(roomId, participants);
		if (decision.unverified.length > 0) {
			this.logger.warn(`Removing ${decision.unverified.map(p => p.identity).join(', ')} from the voice call in ${roomId}, as whether they may stay could not be checked twice`);
		}
		return [...decision.denied, ...decision.unverified.map(p => p.identity)];
	}

	private async countUnverified(roomId: MiChatRoom['id'], identities: string[]): Promise<string[]> {
		const reached: string[] = [];
		for (const identity of identities) {
			try {
				const count = Number(await this.redisClient.eval(COUNT_UNVERIFIED_SCRIPT, 1, this.unverifiedKeyOf(roomId, identity), UNVERIFIED_TTL_SECONDS));
				if (count >= UNVERIFIED_SWEEP_LIMIT) reached.push(identity);
			} catch (err) {
				this.logger.warn(`Failed to count how long ${identity} could not be checked in the voice call in ${roomId}`, { error: err });
			}
		}
		return reached;
	}

	private async forgetUnverified(roomId: MiChatRoom['id'], identities: string[]): Promise<void> {
		if (identities.length === 0) return;
		await this.redisClient.del(...identities.map(identity => this.unverifiedKeyOf(roomId, identity))).catch(err => {
			this.logger.warn(`Failed to reset how long participants could not be checked in the voice call in ${roomId}`, { error: err });
		});
	}

	private unverifiedKeyOf(roomId: MiChatRoom['id'], identity: string): string {
		return `chatVoice:unverified:${roomId}:${identity}`;
	}

	/** ms 待つ。待っているあいだに止められたら false */
	private wait(ms: number): Promise<boolean> {
		if (this.isShuttingDown) return Promise.resolve(false);
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				this.pendingWaits.delete(timer);
				resolve(true);
			}, ms);
			this.pendingWaits.set(timer, resolve);
		});
	}

	/**
	 * 参加者が残れるかを確かめるのに要るものを、すべて同時に読む。どれかが読めなくても、ほかは読む
	 */
	private async admissionContextOf(roomId: MiChatRoom['id'], participants: NamedCallParticipant[]): Promise<AdmissionContext> {
		const ids = [...new Set(participants.map(p => p.userId))];
		const errors: unknown[] = [];
		const read = async <T>(load: () => Promise<T>): Promise<Read<T>> => {
			try {
				return { ok: true, value: await load() };
			} catch (error) {
				errors.push(error);
				return { ok: false, error };
			}
		};

		const [room, users, memberIds, policies] = await Promise.all([
			read(() => this.chatRoomsRepository.findOne({ where: { id: roomId }, relations: { owner: true } })),
			read(async () => new Map((await this.usersRepository.findBy({ id: In(ids) })).map(user => [user.id, user]))),
			read(async () => new Set((await this.chatRoomMembershipsRepository.findBy({ roomId, userId: In(ids) })).map(membership => membership.userId))),
			Promise.all(ids.map(async userId => [userId, await read(() => this.roleService.getUserPolicies(userId))] as const)),
		]);

		// arti: decide once per remote host whether this server refuses it
		const refusedHosts = new Map<string, boolean>();
		if (users.ok) {
			const hosts = [...new Set([...users.value.values()].flatMap(user => user.host ?? []))];
			await Promise.all(hosts.map(async host => {
				const refused = await read(() => this.hostPolicyService.isRefusedRemoteHost(host));
				if (refused.ok) refusedHosts.set(host, refused.value);
			}));
		}

		return { room, users, memberIds, policies: new Map(policies), refusedHosts, errors };
	}

	/**
	 * 参加者が、いまもそのルームの通話に残れるか。トークンを発行するとき (chat/rooms/voice/join) と同じものを確かめる。
	 * - トークンに付けたユーザーがこのサーバーのユーザーで、停止も削除もされておらず、identity がそのユーザーのもの
	 * - ルームがこのサーバーのもので保管されておらず、そのユーザーが持ち主かメンバー
	 * - そのユーザーのロールが通話に入れ、チャットに書き込める (画面共有はそのロールが許すときだけ)
	 */
	private admissionOf(participant: NamedCallParticipant, context: AdmissionContext): Admission {
		let unverified = false;

		if (!context.room.ok) {
			unverified = true;
		} else {
			const room = context.room.value;
			if (room == null || room.isArchived) return 'denied';
			// 他のサーバーが持つルームの通話は、まだ扱わない
			if (room.owner == null || room.owner.host != null) return 'denied';
			if (!context.memberIds.ok) unverified = true;
			else if (room.ownerId !== participant.userId && !context.memberIds.value.has(participant.userId)) return 'denied';
		}

		if (!context.users.ok) {
			unverified = true;
		} else {
			const user = context.users.value.get(participant.userId);
			if (user == null || user.isSuspended || user.isDeleted) return 'denied';
			// arti: remote participants are allowed once remote voice calls are enabled,
			// unless their server is refused (blocked, suspended, or not federated)
			if (user.host != null) {
				if (!isRemoteVoiceCallEnabled(this.meta) || user.uri == null) return 'denied';
				const refused = context.refusedHosts.get(user.host);
				if (refused === true) return 'denied';
				if (refused == null) unverified = true;
			}
			if (participant.identity !== this.liveKitService.identityOf(user)) return 'denied';
		}

		const policies = context.policies.get(participant.userId);
		if (policies == null || !policies.ok) unverified = true;
		else if (!policies.value.canVoiceCall || policies.value.chatAvailability !== 'available') return 'denied';
		else if (!policies.value.canScreenShare && (participant.canScreenShare || participant.screenSharing)) return 'denied';

		return unverified ? 'unverified' : 'admitted';
	}

	/** ルームの持ち主とメンバーのうち、このサーバーのユーザー */
	private async localAudienceOf(room: MiChatRoom): Promise<MiUser['id'][]> {
		const memberships = await this.chatRoomMembershipsRepository.findBy({ roomId: room.id });
		const users = await this.usersRepository.find({
			where: { id: In([room.ownerId, ...memberships.map(m => m.userId)]) },
			select: { id: true, host: true },
		});
		return users.filter(user => user.host == null).map(user => user.id);
	}

	private async pack(roomId: MiChatRoom['id'], snapshot: VoiceSnapshot, me: { id: MiUser['id'] } | null): Promise<Packed<'ChatRoomVoiceState'>> {
		const users = await this.userEntityService.packMany(snapshot.participants.map(p => p.userId), me);
		const usersById = new Map(users.map(user => [user.id, user]));
		const participants: Packed<'ChatRoomVoiceState'>['participants'] = [];
		for (const p of snapshot.participants) {
			const user = usersById.get(p.userId);
			if (user == null) continue;
			participants.push({ identity: p.identity, user, screenSharing: p.screenSharing, ...reportedVoiceStatus(p) });
		}
		return { roomId, participants, updatedAt: snapshot.updatedAt };
	}
}
