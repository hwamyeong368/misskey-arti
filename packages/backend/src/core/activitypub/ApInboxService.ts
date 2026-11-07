/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { UserFollowingService } from '@/core/UserFollowingService.js';
import { ReactionService } from '@/core/ReactionService.js';
import { RelayService } from '@/core/RelayService.js';
import { NotePiningService } from '@/core/NotePiningService.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { acquireApObjectLock } from '@/misc/distributed-lock.js';
import { concat, toArray, toSingle, unique } from '@/misc/prelude/array.js';
import type Logger from '@/logger.js';
import { IdService } from '@/core/IdService.js';
import { StatusError } from '@/misc/status-error.js';
import { UtilityService } from '@/core/UtilityService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { QueueService } from '@/core/QueueService.js';
import type { UsersRepository, NotesRepository, FollowingsRepository, AbuseUserReportsRepository, FollowRequestsRepository, MiMeta, ChatMessagesRepository, ChatRoomsRepository, ChatRoomInvitationsRepository, ChatRoomMembershipsRepository, MiChatRoom } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import type { MiRemoteUser } from '@/models/User.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { AbuseReportService } from '@/core/AbuseReportService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { getApHrefNullable, getApId, getApIds, getApType, isAccept, isActor, isAdd, isAnnounce, isBlock, isCollection, isCollectionOrOrderedCollection, isCreate, isDelete, isFlag, isFollow, isInvite, isLike, isMove, isPost, isReject, isRemove, isTombstone, isUndo, isUpdate, validActor, validPost } from './type.js';
import { ApNoteService } from './models/ApNoteService.js';
import { ApLoggerService } from './ApLoggerService.js';
import { ApDbResolverService } from './ApDbResolverService.js';
import { ApResolverService } from './ApResolverService.js';
import { ApAudienceService } from './ApAudienceService.js';
import { ApPersonService } from './models/ApPersonService.js';
import { ApQuestionService } from './models/ApQuestionService.js';
import { ApImageService } from './models/ApImageService.js';
import { ApMfmService } from './ApMfmService.js';
import type { Resolver } from './ApResolverService.js';
import type { IAccept, IAdd, IAnnounce, IBlock, ICreate, IDelete, IFlag, IFollow, IInvite, ILike, IObject, IReject, IRemove, IUndo, IUpdate, IMove, IPost } from './type.js';

@Injectable()
export class ApInboxService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.followRequestsRepository)
		private followRequestsRepository: FollowRequestsRepository,

		@Inject(DI.chatMessagesRepository)
		private chatMessagesRepository: ChatMessagesRepository,

		@Inject(DI.chatRoomsRepository)
		private chatRoomsRepository: ChatRoomsRepository,

		@Inject(DI.chatRoomInvitationsRepository)
		private chatRoomInvitationsRepository: ChatRoomInvitationsRepository,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,

		private userEntityService: UserEntityService,
		private noteEntityService: NoteEntityService,
		private utilityService: UtilityService,
		private idService: IdService,
		private abuseReportService: AbuseReportService,
		private userFollowingService: UserFollowingService,
		private apAudienceService: ApAudienceService,
		private reactionService: ReactionService,
		private relayService: RelayService,
		private notePiningService: NotePiningService,
		private userBlockingService: UserBlockingService,
		private noteCreateService: NoteCreateService,
		private noteDeleteService: NoteDeleteService,
		private notificationService: NotificationService,
		private chatService: ChatService,
		private chatVoiceService: ChatVoiceService,
		private apResolverService: ApResolverService,
		private apDbResolverService: ApDbResolverService,
		private apLoggerService: ApLoggerService,
		private apNoteService: ApNoteService,
		private apPersonService: ApPersonService,
		private apQuestionService: ApQuestionService,
		private apImageService: ApImageService,
		private apMfmService: ApMfmService,
		private queueService: QueueService,
		private globalEventService: GlobalEventService,
	) {
		this.logger = this.apLoggerService.logger;
	}

	@bindThis
	public async performActivity(actor: MiRemoteUser, activity: IObject, resolver?: Resolver): Promise<string | void> {
		let result = undefined as string | void;
		if (isCollectionOrOrderedCollection(activity)) {
			const results = [] as [string, string | void][];
			// eslint-disable-next-line no-param-reassign
			resolver ??= await this.apResolverService.createResolver();

			const items = toArray(isCollection(activity) ? activity.items : activity.orderedItems);
			if (items.length >= resolver.getRecursionLimit()) {
				throw new Error(`skipping activity: collection would surpass recursion limit: ${this.utilityService.extractDbHost(actor.uri)}`);
			}

			for (const item of items) {
				const act = await resolver.resolve(item);
				if (act.id == null || this.utilityService.extractDbHost(act.id) !== this.utilityService.extractDbHost(actor.uri)) {
					this.logger.debug('skipping activity: activity id is null or mismatching');
					continue;
				}
				try {
					results.push([getApId(item), await this.performOneActivity(actor, act, resolver)]);
				} catch (err) {
					if (err instanceof Error || typeof err === 'string') {
						this.logger.error(err);
					} else {
						throw err;
					}
				}
			}

			const hasReason = results.some(([, reason]) => (reason != null && !reason.startsWith('ok')));
			if (hasReason) {
				result = results.map(([id, reason]) => `${id}: ${reason}`).join('\n');
			}
		} else {
			result = await this.performOneActivity(actor, activity, resolver);
		}

		// ついでにリモートユーザーの情報が古かったら更新しておく
		if (actor.uri) {
			if (actor.lastFetchedAt == null || Date.now() - actor.lastFetchedAt.getTime() > 1000 * 60 * 60 * 24) {
				setImmediate(() => {
					// 同一ユーザーの情報を再度処理するので、使用済みのresolverを再利用してはいけない
					this.apPersonService.updatePerson(actor.uri);
				});
			}
		}
		return result;
	}

	@bindThis
	public async performOneActivity(actor: MiRemoteUser, activity: IObject, resolver?: Resolver): Promise<string | void> {
		if (actor.isSuspended) return;

		if (isCreate(activity)) {
			return await this.create(actor, activity, resolver);
		} else if (isDelete(activity)) {
			return await this.delete(actor, activity);
		} else if (isUpdate(activity)) {
			return await this.update(actor, activity, resolver);
		} else if (isFollow(activity)) {
			return await this.follow(actor, activity);
		} else if (isAccept(activity)) {
			return await this.accept(actor, activity, resolver);
		} else if (isReject(activity)) {
			return await this.reject(actor, activity, resolver);
		} else if (isAdd(activity)) {
			return await this.add(actor, activity, resolver);
		} else if (isRemove(activity)) {
			return await this.remove(actor, activity, resolver);
		} else if (isAnnounce(activity)) {
			return await this.announce(actor, activity, resolver);
		} else if (isLike(activity)) {
			return await this.like(actor, activity);
		} else if (isUndo(activity)) {
			return await this.undo(actor, activity, resolver);
		} else if (isBlock(activity)) {
			return await this.block(actor, activity);
		} else if (isFlag(activity)) {
			return await this.flag(actor, activity);
		} else if (isMove(activity)) {
			return await this.move(actor, activity, resolver);
		} else if (isInvite(activity)) {
			return await this.invite(actor, activity);
		} else {
			return `unrecognized activity type: ${activity.type}`;
		}
	}

	@bindThis
	private async follow(actor: MiRemoteUser, activity: IFollow): Promise<string> {
		const followee = await this.apDbResolverService.getUserFromApId(activity.object);

		if (followee == null) {
			return 'skip: followee not found';
		}

		if (followee.host != null) {
			return 'skip: フォローしようとしているユーザーはローカルユーザーではありません';
		}

		// don't queue because the sender may attempt again when timeout
		await this.userFollowingService.follow(actor, followee, { requestId: activity.id });
		return 'ok';
	}

	@bindThis
	private async like(actor: MiRemoteUser, activity: ILike): Promise<string> {
		const targetUri = getApId(activity.object);

		const note = await this.apNoteService.fetchNote(targetUri);
		if (!note) return `skip: target note not found ${targetUri}`;

		await this.apNoteService.extractEmojis(activity.tag ?? [], actor.host).catch(() => null);

		try {
			await this.reactionService.create(actor, note, activity._misskey_reaction ?? activity.content ?? activity.name);
			return 'ok';
		} catch (err) {
			if (err instanceof IdentifiableError && err.id === '51c42bb4-931a-456b-bff7-e5a8a70dd298') {
				return 'skip: already reacted';
			} else {
				throw err;
			}
		}
	}

	@bindThis
	private async accept(actor: MiRemoteUser, activity: IAccept, resolver?: Resolver): Promise<string> {
		const uri = activity.id ?? activity;

		this.logger.info(`Accept: ${uri}`);

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		const object = await resolver.resolve(activity.object).catch(err => {
			this.logger.error(`Resolution failed: ${err}`);
			throw err;
		});

		if (isFollow(object)) return await this.acceptFollow(actor, object);
		if (isInvite(object)) return await this.acceptInvite(actor, object);

		return `skip: Unknown Accept type: ${getApType(object)}`;
	}

	@bindThis
	private async acceptFollow(actor: MiRemoteUser, activity: IFollow): Promise<string> {
		// ※ activityはこっちから投げたフォローリクエストなので、activity.actorは存在するローカルユーザーである必要がある

		const follower = await this.apDbResolverService.getUserFromApId(activity.actor);

		if (follower == null) {
			return 'skip: follower not found';
		}

		if (follower.host != null) {
			return 'skip: follower is not a local user';
		}

		// relay
		const match = activity.id?.match(/follow-relay\/(\w+)/);
		if (match) {
			return await this.relayService.relayAccepted(match[1], actor);
		}

		await this.userFollowingService.acceptFollowRequest(actor, follower);
		return 'ok';
	}

	@bindThis
	private async add(actor: MiRemoteUser, activity: IAdd, resolver?: Resolver): Promise<string | void> {
		if (actor.uri !== getApId(activity.actor)) {
			return 'invalid actor';
		}

		if (activity.target == null) {
			return 'target is null';
		}

		if (activity.target === actor.featured) {
			const note = await this.apNoteService.resolveNote(activity.object, { resolver });
			if (note == null) return 'note not found';
			await this.notePiningService.addPinned(actor, note.id);
			return;
		}

		return `unknown target: ${activity.target}`;
	}

	@bindThis
	private async announce(actor: MiRemoteUser, activity: IAnnounce, resolver?: Resolver): Promise<string | void> {
		const uri = getApId(activity);

		this.logger.info(`Announce: ${uri}`);

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		if (!activity.object) return 'skip: activity has no object property';
		const targetUri = getApId(activity.object);
		if (targetUri.startsWith('bear:')) return 'skip: bearcaps url not supported.';

		const target = await resolver.resolve(activity.object).catch(e => {
			this.logger.error(`Resolution failed: ${e}`);
			throw e;
		});

		if (isPost(target)) return await this.announceNote(actor, activity, target);

		return `skip: unknown object type ${getApType(target)}`;
	}

	@bindThis
	private async announceNote(actor: MiRemoteUser, activity: IAnnounce, target: IPost, resolver?: Resolver): Promise<string | void> {
		if (actor.isSuspended) {
			return;
		}

		// リレーからのAnnounceかチェック
		const fromRelay = await this.relayService.isRelayActor(actor);
		const uri = getApId(fromRelay ? target : activity);

		// アナウンス先が許可されているかチェック
		if (!this.utilityService.isFederationAllowedUri(uri)) return;

		const activityUri = getApId(activity);
		const unlock = await acquireApObjectLock(this.redisClient, activityUri);

		try {
			// 既に同じURIを持つものが登録されていないかチェック
			const exist = await this.apNoteService.fetchNote(uri);
			if (exist) {
				return;
			}

			// Announce対象をresolve
			let renote;
			try {
				renote = await this.apNoteService.resolveNote(target, { resolver });
				if (renote == null) return 'announce target is null';
			} catch (err) {
				// 対象が4xxならスキップ
				if (err instanceof StatusError) {
					if (!err.isRetryable) {
						return `Ignored announce target ${target.id} - ${err.statusCode}`;
					}
					return `Error in announce target ${target.id} - ${err.statusCode}`;
				}
				throw err;
			}

			// リレーからのAnnounceはリノートを作成せず、ノートを直接公開する
			if (fromRelay) {
				this.logger.info(`Publishing relay-delivered note: ${uri}`);
				const noteObj = await this.noteEntityService.pack(renote, null, { skipHide: true, withReactionAndUserPairCache: true });
				this.globalEventService.publishNotesStream(noteObj);
				return;
			}

			if (!await this.noteEntityService.isVisibleForMe(renote, actor.id)) {
				return 'skip: invalid actor for this activity';
			}

			this.logger.info(`Creating the (Re)Note: ${uri}`);

			const activityAudience = await this.apAudienceService.parseAudience(actor, activity.to, activity.cc, resolver);
			const createdAt = activity.published ? new Date(activity.published) : null;

			if (createdAt && createdAt < this.idService.parse(renote.id).date) {
				return 'skip: malformed createdAt';
			}

			await this.noteCreateService.create(actor, {
				createdAt,
				renote,
				visibility: activityAudience.visibility,
				visibleUsers: activityAudience.visibleUsers,
				uri,
			});
		} finally {
			unlock();
		}
	}

	@bindThis
	private async block(actor: MiRemoteUser, activity: IBlock): Promise<string> {
		// ※ activity.objectにブロック対象があり、それは存在するローカルユーザーのはず

		const blockee = await this.apDbResolverService.getUserFromApId(activity.object);

		if (blockee == null) {
			return 'skip: blockee not found';
		}

		if (blockee.host != null) {
			return 'skip: ブロックしようとしているユーザーはローカルユーザーではありません';
		}

		await this.userBlockingService.block(await this.usersRepository.findOneByOrFail({ id: actor.id }), await this.usersRepository.findOneByOrFail({ id: blockee.id }));
		return 'ok';
	}

	@bindThis
	private async create(actor: MiRemoteUser, activity: ICreate, resolver?: Resolver): Promise<string | void> {
		const uri = getApId(activity);

		this.logger.info(`Create: ${uri}`);

		if (!activity.object) return 'skip: activity has no object property';
		const targetUri = getApId(activity.object);
		if (targetUri.startsWith('bear:')) return 'skip: bearcaps url not supported.';

		// copy audiences between activity <=> object.
		if (typeof activity.object === 'object') {
			const to = unique(concat([toArray(activity.to), toArray(activity.object.to)]));
			const cc = unique(concat([toArray(activity.cc), toArray(activity.object.cc)]));

			activity.to = to;
			activity.cc = cc;
			activity.object.to = to;
			activity.object.cc = cc;
		}

		// If there is no attributedTo, use Activity actor.
		if (typeof activity.object === 'object' && !activity.object.attributedTo) {
			activity.object.attributedTo = activity.actor;
		}

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		const object = await resolver.resolve(activity.object).catch(e => {
			this.logger.error(`Resolution failed: ${e}`);
			throw e;
		});

		if (isPost(object)) {
			// arti: legacy Misskey talk format = chat message (from CherryPick)
			if ((object as IPost)._misskey_talk === true) {
				return await this.createChatMessage(actor, object as IPost);
			}
			await this.createNote(resolver, actor, object, false, activity);
		} else {
			return `Unknown type: ${getApType(object)}`;
		}
	}

	@bindThis
	private async createNote(resolver: Resolver, actor: MiRemoteUser, note: IObject, silent = false, activity?: ICreate): Promise<string> {
		const uri = getApId(note);

		if (typeof note === 'object') {
			if (actor.uri !== note.attributedTo) {
				return 'skip: actor.uri !== note.attributedTo';
			}

			if (typeof note.id === 'string') {
				if (this.utilityService.extractDbHost(actor.uri) !== this.utilityService.extractDbHost(note.id)) {
					return 'skip: host in actor.uri !== note.id';
				}
			} else {
				return 'skip: note.id is not a string';
			}
		}

		const unlock = await acquireApObjectLock(this.redisClient, uri);

		try {
			const exist = await this.apNoteService.fetchNote(note);
			if (exist) return 'skip: note exists';

			await this.apNoteService.createNote(note, actor, resolver, silent);
			return 'ok';
		} catch (err) {
			if (err instanceof StatusError && !err.isRetryable) {
				return `skip ${err.statusCode}`;
			} else {
				throw err;
			}
		} finally {
			unlock();
		}
	}

	@bindThis
	private async delete(actor: MiRemoteUser, activity: IDelete): Promise<string> {
		if (actor.uri !== getApId(activity.actor)) {
			return 'invalid actor';
		}

		// 削除対象objectのtype
		let formerType: string | undefined;

		if (typeof activity.object === 'string') {
			// typeが不明だけど、どうせ消えてるのでremote resolveしない
			formerType = undefined;
		} else {
			const object = activity.object;
			if (isTombstone(object)) {
				formerType = toSingle(object.formerType);
			} else {
				formerType = toSingle(object.type);
			}
		}

		const uri = getApId(activity.object);

		// type不明でもactorとobjectが同じならばそれはPersonに違いない
		if (!formerType && actor.uri === uri) {
			formerType = 'Person';
		}

		// それでもなかったらおそらくNote
		if (!formerType) {
			formerType = 'Note';
		}

		if (validPost.includes(formerType)) {
			return await this.deleteNote(actor, uri);
		} else if (validActor.includes(formerType)) {
			return await this.deleteActor(actor, uri);
		} else {
			return `Unknown type ${formerType}`;
		}
	}

	@bindThis
	private async deleteActor(actor: MiRemoteUser, uri: string): Promise<string> {
		this.logger.info(`Deleting the Actor: ${uri}`);

		if (actor.uri !== uri) {
			return `skip: delete actor ${actor.uri} !== ${uri}`;
		}

		if (!(await this.usersRepository.update({ id: actor.id, isDeleted: false }, { isDeleted: true })).affected) {
			return 'skip: already deleted or actor not found';
		}

		const job = await this.queueService.createDeleteAccountJob(actor);

		this.globalEventService.publishInternalEvent('remoteUserUpdated', { id: actor.id });

		return `ok: queued ${job.name} ${job.id}`;
	}

	@bindThis
	private async deleteNote(actor: MiRemoteUser, uri: string): Promise<string> {
		this.logger.info(`Deleting the Note: ${uri}`);

		const unlock = await acquireApObjectLock(this.redisClient, uri);

		try {
			const note = await this.apDbResolverService.getNoteFromApId(uri);

			if (note == null) {
				return 'message not found';
			}

			if (note.userId !== actor.id) {
				return '投稿を削除しようとしているユーザーは投稿の作成者ではありません';
			}

			await this.noteDeleteService.delete(actor, note);
			return 'ok: note deleted';
		} finally {
			unlock();
		}
	}

	@bindThis
	private async flag(actor: MiRemoteUser, activity: IFlag): Promise<string> {
		// objectは `(User|Note) | (User|Note)[]` だけど、全パターンDBスキーマと対応させられないので
		// 対象ユーザーは一番最初のユーザー として あとはコメントとして格納する
		const uris = getApIds(activity.object);

		const userIds = uris
			.filter(uri => uri.startsWith(this.config.url + '/users/'))
			.map(uri => uri.split('/').at(-1))
			.filter(x => x != null);
		const users = await this.usersRepository.findBy({
			id: In(userIds),
		});
		if (users.length < 1) return 'skip';

		await this.abuseReportService.report([{
			targetUserId: users[0].id,
			targetUserHost: users[0].host,
			reporterId: actor.id,
			reporterHost: actor.host,
			comment: `${activity.content}\n${JSON.stringify(uris, null, 2)}`,
		}]);

		return 'ok';
	}

	@bindThis
	private async reject(actor: MiRemoteUser, activity: IReject, resolver?: Resolver): Promise<string> {
		const uri = activity.id ?? activity;

		this.logger.info(`Reject: ${uri}`);

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		const object = await resolver.resolve(activity.object).catch(e => {
			this.logger.error(`Resolution failed: ${e}`);
			throw e;
		});

		if (isFollow(object)) return await this.rejectFollow(actor, object);
		if (isInvite(object)) return await this.rejectInvite(actor, object);

		return `skip: Unknown Reject type: ${getApType(object)}`;
	}

	@bindThis
	private async rejectFollow(actor: MiRemoteUser, activity: IFollow): Promise<string> {
		// ※ activityはこっちから投げたフォローリクエストなので、activity.actorは存在するローカルユーザーである必要がある

		const follower = await this.apDbResolverService.getUserFromApId(activity.actor);

		if (follower == null) {
			return 'skip: follower not found';
		}

		if (!this.userEntityService.isLocalUser(follower)) {
			return 'skip: follower is not a local user';
		}

		// relay
		const match = activity.id?.match(/follow-relay\/(\w+)/);
		if (match) {
			return await this.relayService.relayRejected(match[1], actor);
		}

		await this.userFollowingService.remoteReject(actor, follower);
		return 'ok';
	}

	@bindThis
	private async remove(actor: MiRemoteUser, activity: IRemove, resolver?: Resolver): Promise<string | void> {
		if (actor.uri !== getApId(activity.actor)) {
			return 'invalid actor';
		}

		if (activity.target == null) {
			return 'target is null';
		}

		if (activity.target === actor.featured) {
			const note = await this.apNoteService.resolveNote(activity.object, { resolver });
			if (note == null) return 'note not found';
			await this.notePiningService.removePinned(actor, note.id);
			return;
		}

		// arti: a remote member left a chat room (from CherryPick)
		const targetRoom = this.parseChatRoomUri(getApId(activity.target));
		if (targetRoom) {
			if (getApId(activity.object) !== actor.uri) return 'skip: can only remove yourself from a chat room';
			const room = await this.findFederatedChatRoom(targetRoom, { allowLocalRoomWithForeignHost: true });
			if (room == null) return 'skip: chat room not found';
			await this.chatRoomMembershipsRepository.delete({ roomId: room.id, userId: actor.id });
			return 'ok: left chat room';
		}

		return `unknown target: ${activity.target}`;
	}

	@bindThis
	private async undo(actor: MiRemoteUser, activity: IUndo, resolver?: Resolver): Promise<string> {
		if (actor.uri !== getApId(activity.actor)) {
			return 'invalid actor';
		}

		const uri = activity.id ?? activity;

		this.logger.info(`Undo: ${uri}`);

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		const object = await resolver.resolve(activity.object).catch(e => {
			this.logger.error(`Resolution failed: ${e}`);
			throw e;
		});

		// don't queue because the sender may attempt again when timeout
		if (isFollow(object)) return await this.undoFollow(actor, object);
		if (isBlock(object)) return await this.undoBlock(actor, object);
		if (isLike(object)) return await this.undoLike(actor, object);
		if (isAnnounce(object)) return await this.undoAnnounce(actor, object);
		if (isAccept(object)) return await this.undoAccept(actor, object);
		if (isInvite(object)) return await this.undoInvite(actor, object);

		return `skip: unknown object type ${getApType(object)}`;
	}

	@bindThis
	private async undoAccept(actor: MiRemoteUser, activity: IAccept): Promise<string> {
		const follower = await this.apDbResolverService.getUserFromApId(activity.object);
		if (follower == null) {
			return 'skip: follower not found';
		}

		const isFollowing = await this.followingsRepository.exists({
			where: {
				followerId: follower.id,
				followeeId: actor.id,
			},
		});

		if (isFollowing) {
			await this.userFollowingService.unfollow(follower, actor);
			return 'ok: unfollowed';
		}

		return 'skip: フォローされていない';
	}

	@bindThis
	private async undoAnnounce(actor: MiRemoteUser, activity: IAnnounce): Promise<string> {
		const uri = getApId(activity);

		const note = await this.notesRepository.findOneBy({
			uri,
			userId: actor.id,
		});

		if (!note) return 'skip: no such Announce';

		await this.noteDeleteService.delete(actor, note);
		return 'ok: deleted';
	}

	@bindThis
	private async undoBlock(actor: MiRemoteUser, activity: IBlock): Promise<string> {
		const blockee = await this.apDbResolverService.getUserFromApId(activity.object);

		if (blockee == null) {
			return 'skip: blockee not found';
		}

		if (blockee.host != null) {
			return 'skip: ブロック解除しようとしているユーザーはローカルユーザーではありません';
		}

		await this.userBlockingService.unblock(await this.usersRepository.findOneByOrFail({ id: actor.id }), blockee);
		return 'ok';
	}

	@bindThis
	private async undoFollow(actor: MiRemoteUser, activity: IFollow): Promise<string> {
		const followee = await this.apDbResolverService.getUserFromApId(activity.object);
		if (followee == null) {
			return 'skip: followee not found';
		}

		if (followee.host != null) {
			return 'skip: フォロー解除しようとしているユーザーはローカルユーザーではありません';
		}

		const requestExist = await this.followRequestsRepository.exists({
			where: {
				followerId: actor.id,
				followeeId: followee.id,
			},
		});

		const isFollowing = await this.followingsRepository.exists({
			where: {
				followerId: actor.id,
				followeeId: followee.id,
			},
		});

		if (requestExist) {
			await this.userFollowingService.cancelFollowRequest(followee, actor);
			return 'ok: follow request canceled';
		}

		if (isFollowing) {
			await this.userFollowingService.unfollow(actor, followee);
			return 'ok: unfollowed';
		}

		return 'skip: リクエストもフォローもされていない';
	}

	@bindThis
	private async undoLike(actor: MiRemoteUser, activity: ILike): Promise<string> {
		const targetUri = getApId(activity.object);

		const note = await this.apNoteService.fetchNote(targetUri);
		if (!note) return `skip: target note not found ${targetUri}`;

		await this.reactionService.delete(actor, note).catch(e => {
			if (e.id === '60527ec9-b4cb-4a88-a6bd-32d3ad26817d') return;
			throw e;
		});

		return 'ok';
	}

	@bindThis
	private async update(actor: MiRemoteUser, activity: IUpdate, resolver?: Resolver): Promise<string> {
		if (actor.uri !== getApId(activity.actor)) {
			return 'skip: invalid actor';
		}

		this.logger.debug('Update');

		// eslint-disable-next-line no-param-reassign
		resolver ??= await this.apResolverService.createResolver();

		const object = await resolver.resolve(activity.object).catch(e => {
			this.logger.error(`Resolution failed: ${e}`);
			throw e;
		});

		if (isActor(object)) {
			await this.apPersonService.updatePerson(actor.uri, resolver, object);
			return 'ok: Person updated';
		} else if (getApType(object) === 'Question') {
			await this.apQuestionService.updateQuestion(object, actor, resolver).catch(err => console.error(err));
			return 'ok: Question updated';
		} else if (getApType(object) === 'Note') {
			await this.apNoteService.updateNote(object, actor, resolver).catch(err => console.error(err));
			return 'ok: Note updated';
		} else if (getApType(object) === 'ChatRoomVoiceState') {
			// arti: the owner of a mirror room reports who is in its call
			return await this.chatVoiceService.receiveRemoteSnapshot(actor, object);
		} else {
			return `skip: Unknown type: ${getApType(object)}`;
		}
	}

	@bindThis
	private async move(actor: MiRemoteUser, activity: IMove, resolver?: Resolver): Promise<string> {
		// fetch the new and old accounts
		const targetUri = getApHrefNullable(activity.target);
		if (!targetUri) return 'skip: invalid activity target';

		return await this.apPersonService.updatePerson(actor.uri, resolver) ?? 'skip: nothing to do';
	}

	//#region arti: chat federation (ported from CherryPick, with extra checks)

	/**
	 * `https://host/chat/rooms/{id}` -> room id and host
	 */
	@bindThis
	private parseChatRoomUri(uri: string): { roomId: MiChatRoom['id']; host: string } | null {
		const match = uri.match(/^https?:\/\/[^/]+\/chat\/rooms\/([a-zA-Z0-9]+)$/);
		if (!match) return null;
		return { roomId: match[1], host: this.utilityService.extractDbHost(uri) };
	}

	/**
	 * Find a room by its federated URI. The room must really belong to the server in the URI:
	 * a room of this server must have a local owner, a copied remote room must have an owner from that host.
	 * This stops a remote server from naming one of our room ids to get into it.
	 */
	@bindThis
	private async findFederatedChatRoom(target: { roomId: MiChatRoom['id']; host: string }, options?: { allowLocalRoomWithForeignHost?: boolean }): Promise<MiChatRoom | null> {
		const room = await this.chatRoomsRepository.findOne({ where: { id: target.roomId }, relations: { owner: true } });
		if (room == null || room.owner == null) return null;

		const roomIsLocal = this.utilityService.isSelfHost(target.host);
		if (roomIsLocal) return room.owner.host == null ? room : null;

		// arti: another server names its own copy of a room (same id, its own host) in chat
		// messages, Accepts and Removes. A room that is local to us can still be the target;
		// membership and invitation checks decide whether the actor may act on it.
		if (options?.allowLocalRoomWithForeignHost && room.owner.host == null) return room;
		if (room.owner.host !== target.host) return null;

		return room;
	}

	@bindThis
	private getChatRoomUriFromInvite(invite: IInvite): { roomId: MiChatRoom['id']; host: string } | null {
		if (invite.object == null) return null;
		return this.parseChatRoomUri(getApId(invite.object));
	}

	@bindThis
	private async createChatMessage(actor: MiRemoteUser, object: IPost): Promise<string> {
		if (actor.isSuspended) return 'skip: actor is suspended';
		if (typeof object.id !== 'string') return 'skip: chat message has no id';
		if (object.id.length > 512) return 'skip: chat message id is too long';
		if (this.utilityService.extractDbHost(object.id) !== this.utilityService.extractDbHost(actor.uri)) return 'skip: chat message is not from the actor host';
		if (getApHrefNullable(toSingle(object.attributedTo)) !== actor.uri) return 'skip: chat message is not attributed to the actor';

		const exists = await this.chatMessagesRepository.existsBy({ uri: object.id });
		if (exists) return 'skip: chat message already exists';

		let text: string | null = null;
		if (object.source?.mediaType === 'text/x.misskeymarkdown' && typeof object.source.content === 'string') {
			text = object.source.content;
		} else if (typeof object._misskey_content === 'string') {
			text = object._misskey_content;
		} else if (typeof object.content === 'string') {
			text = this.apMfmService.htmlToMfm(object.content, object.tag);
		}
		if (text != null) text = text.slice(0, 4096);

		const attachment = toArray(object.attachment)[0];
		const file = attachment ? await this.apImageService.resolveImage(actor, attachment).catch(err => {
			this.logger.warn(`chat: failed to resolve attachment: ${err}`);
			return null;
		}) : null;

		const emojis = (await this.apNoteService.extractEmojis(object.tag ?? [], actor.host).catch(() => [])).map(emoji => emoji.name);

		try {
			const context = object['@context'];
			const roomTarget = typeof context === 'string' ? this.parseChatRoomUri(context) : null;

			if (roomTarget) {
				// group chat: ChatService checks that the actor is a member
				const room = await this.findFederatedChatRoom(roomTarget, { allowLocalRoomWithForeignHost: true });
				if (room == null) return 'skip: chat room not found';

				// our copy of a remote room only knows its owner at first.
				// The owner's server speaks for its own room, so its other members are added when they talk.
				if (room.owner!.host != null && actor.host === room.owner!.host && !(await this.chatService.isRoomMember(room, actor.id))) {
					await this.chatRoomMembershipsRepository.insertOne({
						id: this.idService.gen(),
						roomId: room.id,
						userId: actor.id,
					});
				}

				await this.chatService.createMessageToRoom(actor, room, { text, file, uri: object.id, emojis });
			} else {
				// 1:1 chat: exactly one local recipient
				const recipients = [];
				for (const uri of getApIds(object.to)) {
					if (!this.utilityService.isSelfHost(this.utilityService.extractDbHost(uri))) continue;
					const user = await this.apDbResolverService.getUserFromApId(uri);
					if (user != null && this.userEntityService.isLocalUser(user)) recipients.push(user);
				}
				if (recipients.length !== 1) return 'skip: a chat message needs exactly one local recipient';
				await this.chatService.createMessageToUser(actor, recipients[0], { text, file, uri: object.id, emojis });
			}
		} catch (err) {
			// permission errors (blocked, chat closed, not a member ...) should not be retried
			if (err instanceof Error) return `skip: ${err.message}`;
			throw err;
		}

		return 'ok';
	}

	@bindThis
	private async invite(actor: MiRemoteUser, activity: IInvite): Promise<string> {
		if (actor.uri !== getApId(activity.actor)) return 'skip: invalid actor';
		if (actor.isSuspended) return 'skip: actor is suspended';

		const roomObject = activity.object;
		if (typeof roomObject === 'string') return 'skip: room must be an embedded object';

		const target = this.parseChatRoomUri(getApId(roomObject));
		if (target == null) return 'skip: invalid room URI';
		// only the owner of a room on the actor's own server can invite
		if (target.host !== this.utilityService.extractDbHost(actor.uri)) return 'skip: room is not on the actor host';
		const ownerUri = getApHrefNullable(toSingle(roomObject.attributedTo));
		if (ownerUri != null && ownerUri !== actor.uri) return 'skip: only the room owner can invite';

		const inviteeUri = getApHrefNullable(activity.target);
		if (inviteeUri == null) return 'skip: invalid invitee';
		const invitee = await this.apDbResolverService.getUserFromApId(inviteeUri);
		if (invitee == null || !this.userEntityService.isLocalUser(invitee)) return 'skip: invitee is not a local user';

		if (await this.userBlockingService.checkBlocked(invitee.id, actor.id)) return 'skip: blocked';
		if (!(await this.chatService.getChatAvailability(invitee.id)).write) return 'skip: invitee cannot chat';

		let room = await this.chatRoomsRepository.findOneBy({ id: target.roomId });
		if (room == null) {
			// keep a local copy of the remote room, with the same id as the original
			room = await this.chatRoomsRepository.insertOne({
				id: target.roomId,
				name: (typeof roomObject.name === 'string' ? roomObject.name : 'Chat room').slice(0, 256),
				description: (typeof roomObject.summary === 'string' ? roomObject.summary : '').slice(0, 2048),
				ownerId: actor.id,
			});
		} else if (room.ownerId !== actor.id) {
			return 'skip: room id is already used by another room';
		}

		if (await this.chatRoomInvitationsRepository.existsBy({ roomId: room.id, userId: invitee.id })) return 'skip: already invited';
		if (await this.chatService.isRoomMember(room, invitee.id)) return 'skip: already a member';

		const invitation = await this.chatRoomInvitationsRepository.insertOne({
			id: this.idService.gen(),
			roomId: room.id,
			userId: invitee.id,
		});

		this.notificationService.createNotification(invitee.id, 'chatRoomInvitationReceived', {
			invitationId: invitation.id,
		}, actor.id);

		return 'ok';
	}

	@bindThis
	private async acceptInvite(actor: MiRemoteUser, invite: IInvite): Promise<string> {
		const target = this.getChatRoomUriFromInvite(invite);
		if (target == null) return 'skip: invalid room URI';

		const room = await this.findFederatedChatRoom(target, { allowLocalRoomWithForeignHost: true });
		if (room == null) return 'skip: chat room not found';

		// joinToRoom requires a pending invitation for the actor, so nobody can join uninvited
		try {
			await this.chatService.joinToRoom(actor.id, room.id);
		} catch (err) {
			if (err instanceof Error) return `skip: ${err.message}`;
			throw err;
		}

		return 'ok';
	}

	@bindThis
	private async rejectInvite(actor: MiRemoteUser, invite: IInvite): Promise<string> {
		const target = this.getChatRoomUriFromInvite(invite);
		if (target == null) return 'skip: invalid room URI';

		const room = await this.findFederatedChatRoom(target, { allowLocalRoomWithForeignHost: true });
		if (room == null) return 'skip: chat room not found';

		await this.chatRoomInvitationsRepository.delete({ roomId: room.id, userId: actor.id });
		return 'ok';
	}

	@bindThis
	private async undoInvite(actor: MiRemoteUser, invite: IInvite): Promise<string> {
		const target = this.getChatRoomUriFromInvite(invite);
		if (target == null) return 'skip: invalid room URI';

		const room = await this.findFederatedChatRoom(target, { allowLocalRoomWithForeignHost: true });
		if (room == null || room.ownerId !== actor.id) return 'skip: only the room owner can cancel an invitation';

		const inviteeUri = getApHrefNullable(invite.target);
		if (inviteeUri == null) return 'skip: invalid invitee';
		const invitee = await this.apDbResolverService.getUserFromApId(inviteeUri);
		if (invitee == null || !this.userEntityService.isLocalUser(invitee)) return 'skip: invitee is not a local user';

		await this.chatRoomInvitationsRepository.delete({ roomId: room.id, userId: invitee.id });
		return 'ok';
	}

	//#endregion
}
