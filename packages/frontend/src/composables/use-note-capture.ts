/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onUnmounted, reactive } from 'vue';
import * as Misskey from 'misskey-js';
import { EventEmitter } from 'eventemitter3';
import { createVisibilityAwareInterval } from '@@/js/interval.js';
import type { Reactive } from 'vue';
import type { NoteUpdatedEvent } from 'misskey-js/streaming.types.js';
import { useStream } from '@/stream.js';
import { $i } from '@/i.js';
import { store } from '@/store.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { prefer } from '@/preferences.js';
import { globalEvents } from '@/events.js';

export const noteEvents = new EventEmitter<{
	[ev: `reacted:${string}`]: (ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; } | null; }) => void;
	[ev: `unreacted:${string}`]: (ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; } | null; }) => void;
	[ev: `pollVoted:${string}`]: (ctx: { userId: Misskey.entities.User['id']; choice: number; }) => void;
	[ev: `noteUpdated:${string}`]: (ctx: {
		cw: Misskey.entities.Note['cw'];
		text: Misskey.entities.Note['text'];
		visibility: Misskey.entities.Note['visibility'];
		updatedAt: Misskey.entities.Note['updatedAt'];
		files?: Misskey.entities.DriveFile[];
		fileIds?: string[] | null;
		poll?: Misskey.entities.Note['poll'];
		hasPoll?: boolean;
	}) => void;
}>();

const fetchEvent = new EventEmitter<{
	[id: string]: Pick<Misskey.entities.Note, 'reactions' | 'reactionEmojis'>;
}>();

const pollingQueue = new Map<string, {
	referenceCount: number;
	lastAddedAt: number;
}>();

// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
function pollingEnqueue(note: Pick<Misskey.entities.Note, 'id' | 'createdAt'>, queue = pollingQueue) {
	if (queue.has(note.id)) {
		const data = queue.get(note.id)!;
		queue.set(note.id, {
			...data,
			referenceCount: data.referenceCount + 1,
			lastAddedAt: Date.now(),
		});
	} else {
		queue.set(note.id, {
			referenceCount: 1,
			lastAddedAt: Date.now(),
		});
	}
}

// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
function pollingDequeue(note: Pick<Misskey.entities.Note, 'id' | 'createdAt'>, queue = pollingQueue) {
	const data = queue.get(note.id);
	if (data == null) return;

	if (data.referenceCount === 1) {
		queue.delete(note.id);
	} else {
		queue.set(note.id, {
			...data,
			referenceCount: data.referenceCount - 1,
		});
	}
}

const CAPTURE_MAX = 30;
const MIN_POLLING_INTERVAL = 1000 * 10;
const POLLING_INTERVAL =
	prefer.s.pollingInterval === 1 ? MIN_POLLING_INTERVAL * 1.5 * 1.5 :
	prefer.s.pollingInterval === 2 ? MIN_POLLING_INTERVAL * 1.5 :
	prefer.s.pollingInterval === 3 ? MIN_POLLING_INTERVAL :
	MIN_POLLING_INTERVAL;

// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
// `maxRequests` lets the reconnect catch-up refresh every live subscription in CAPTURE_MAX-sized chunks, and
// `maxAgeMs` lifts upstream's "skip entries older than 5 min" rule for it: a realtime subscription stays
// active until unmount, so its snapshot must cover old entries too. The polling interval keeps upstream's values.
function fetchSnapshot(queue: Map<string, { lastAddedAt: number }>, maxRequests = 1, maxAgeMs = 1000 * 60 * 5) {
	const ids = [...queue.entries()]
		.filter(([k, v]) => Date.now() - v.lastAddedAt < maxAgeMs) // 追加されてから一定時間経過したものは省く
		.map(([k, v]) => k)
		.sort((a, b) => (a > b ? -1 : 1)) // 新しいものを優先するためにIDで降順ソート
		.slice(0, CAPTURE_MAX * maxRequests);

	if (ids.length === 0) return;

	// kyunet: fix/note-capture-shared-state
	fetchSnapshotIds(ids);
}

// kyunet: fix/note-capture-shared-state
function fetchSnapshotIds(ids: string[]) {
	for (let i = 0; i < ids.length; i += CAPTURE_MAX) {
		const chunk = ids.slice(i, i + CAPTURE_MAX);
		// まとめてリクエストするのではなく、個別にHTTPリクエスト投げてCDNにキャッシュさせた方がサーバーの負荷低減には良いかもしれない？
		misskeyApi('notes/show-partial-bulk', {
			noteIds: chunk,
		}).then((items) => {
			for (const item of items) {
				fetchEvent.emit(item.id, {
					reactions: item.reactions,
					reactionEmojis: item.reactionEmojis,
				});
			}

			// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
			// The server omits notes that no longer exist or are no longer visible, so a missing id is treated as
			// deleted. An empty response is skipped: signed-out with ugcVisibilityForVisitor=none returns [] for everything.
			if ($i == null || items.length === 0) return;
			const returned = new Set(items.map(x => x.id));
			for (const id of chunk) {
				if (!returned.has(id)) globalEvents.emit('noteDeleted', id);
			}
		});
	}
}

// documentが非表示の間はポーリングを停止する
createVisibilityAwareInterval(() => {
	fetchSnapshot(pollingQueue);
}, POLLING_INTERVAL);

// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
// Kept apart from pollingQueue: the interval above always runs, and sharing the map would start polling in realtime mode.
const realtimeQueue = new Map<string, {
	referenceCount: number;
	lastAddedAt: number;
}>();

const REALTIME_SNAPSHOT_MAX_REQUESTS = 5;

function refreshRealtimeSnapshot() {
	fetchSnapshot(realtimeQueue, REALTIME_SNAPSHOT_MAX_REQUESTS, Infinity);
}

globalEvents.on('streamReconnected', refreshRealtimeSnapshot);

// A backgrounded tab can hold a dead socket without a close event for a while; refresh on return as well.
window.document.addEventListener('visibilitychange', () => {
	if (window.document.visibilityState !== 'visible') return;
	refreshRealtimeSnapshot();
});

function pollingSubscribe(props: {
	note: Pick<Misskey.entities.Note, 'id' | 'createdAt'>;
}) {
	const { note } = props;

	// kyunet: fix/note-capture-shared-state
	// the fetchEvent handler lives on the shared capture entry
	pollingEnqueue(note);

	onUnmounted(() => {
		pollingDequeue(note);
	});
}

// bscone: the stream only signals that a note was edited, so fetch the new content through notes/show
// (which applies visibility rules). Requests are deduplicated per note and spread out to avoid a burst on popular notes.
const UPDATED_NOTE_REFETCH_MAX_DELAY = 2000;
const refetchingUpdatedNotes = new Set<Misskey.entities.Note['id']>();

function refetchUpdatedNote(id: Misskey.entities.Note['id']): void {
	if (refetchingUpdatedNotes.has(id)) return;
	refetchingUpdatedNotes.add(id);

	window.setTimeout(() => {
		misskeyApi('notes/show', { noteId: id }).then(note => {
			globalEvents.emit('noteUpdated', {
				id,
				cw: note.cw,
				text: note.text,
				visibility: note.visibility,
				updatedAt: note.updatedAt,
				files: note.files,
				fileIds: note.fileIds,
				poll: note.poll,
			});

			noteEvents.emit(`noteUpdated:${id}`, {
				cw: note.cw ?? null,
				text: note.text,
				visibility: note.visibility,
				updatedAt: note.updatedAt,
				files: note.files,
				fileIds: note.fileIds,
				poll: note.poll ?? null,
				hasPoll: note.poll != null,
			});
		}).catch(() => {
			// the note may have been deleted or become invisible; other stream events handle that
		}).finally(() => {
			refetchingUpdatedNotes.delete(id);
		});
	}, Math.random() * UPDATED_NOTE_REFETCH_MAX_DELAY);
}

function realtimeSubscribe(props: {
	note: Pick<Misskey.entities.Note, 'id' | 'createdAt'>;
	// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
	// kyunet: fix/note-capture-shared-state
	entry: CaptureEntry;
}): void {
	const { note, entry } = props;
	const connection = useStream();

	// kyunet: fix/note-capture-shared-state
	// The server ref-counts `sr` per id, so every display still sends it; the noteUpdated bridge into noteEvents
	// is registered once per note so one stream event is applied once.
	function capture(withHandler = false): void {
		connection.send('sr', { id: note.id });
		if (withHandler && entry.realtimeCount++ === 0) connection.on('noteUpdated', entry.onStreamNoteUpdated);
	}

	function decapture(withHandler = false): void {
		connection.send('un', { id: note.id });
		if (withHandler && --entry.realtimeCount === 0) connection.off('noteUpdated', entry.onStreamNoteUpdated);
	}

	function onStreamConnected() {
		capture(false);
	}

	capture(true);
	connection.on('_connected_', onStreamConnected);
	// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
	pollingEnqueue(note, realtimeQueue);

	onUnmounted(() => {
		decapture(true);
		connection.off('_connected_', onStreamConnected);
		// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
		pollingDequeue(note, realtimeQueue);
	});
}

export type ReactiveNoteData = {
	reactions: Misskey.entities.Note['reactions'];
	reactionCount: Misskey.entities.Note['reactionCount'];
	reactionEmojis: Misskey.entities.Note['reactionEmojis'];
	myReaction: Misskey.entities.Note['myReaction'];
	pollChoices: NonNullable<Misskey.entities.Note['poll']>['choices'];
	// kyunet: fix/note-capture-shared-state
	renoteCount: Misskey.entities.Note['renoteCount'];
	repliesCount: Misskey.entities.Note['repliesCount'];
	cw: Misskey.entities.Note['cw'] | null;
	text: Misskey.entities.Note['text'];
	visibility: Misskey.entities.Note['visibility'];
	updatedAt: Misskey.entities.Note['updatedAt'];
};

const noReaction = Symbol();

// kyunet: fix/note-capture-shared-state
// One state per note id, shared by every display of that note (timeline, renote, notification, deck columns).
// Upstream kept a copy per display seeded from whatever the API returned at mount time, then applied the same
// stream events to each, so a renote fetched later kept showing larger counts than the original forever.
// The reaction handlers below are upstream's, moved here from useNoteCapture unchanged except for the state they touch.
type CaptureEntry = {
	$note: Reactive<ReactiveNoteData>;
	refCount: number;
	realtimeCount: number;
	notes: Set<Misskey.entities.Note>;
	onStreamNoteUpdated: (noteData: NoteUpdatedEvent) => void;
	dispose: () => void;
};

const captureEntries = new Map<string, CaptureEntry>();

function normalizeReactionName(reaction: string): string {
	const normalizedName = reaction.replace(/^:(\w+):$/, ':$1@.:');
	return normalizedName.match('\u200d') ? normalizedName : normalizedName.replace(/\ufe0f/g, '');
}

function normalizeReactions(reactions: Misskey.entities.Note['reactions']): Misskey.entities.Note['reactions'] {
	return Object.entries(reactions).reduce((acc, [name, count]) => {
		// Normalize reactions
		const normalizedName = name.replace(/^:(\w+):$/, ':$1@.:');
		if (acc[normalizedName] == null) {
			acc[normalizedName] = count;
		} else {
			acc[normalizedName] += count;
		}
		return acc;
	}, {} as Misskey.entities.Note['reactions']);
}

function createEntry(note: Misskey.entities.Note): CaptureEntry {
	const $note = reactive<ReactiveNoteData>({
		reactions: normalizeReactions(note.reactions),
		reactionCount: note.reactionCount,
		reactionEmojis: note.reactionEmojis,
		myReaction: note.myReaction,
		pollChoices: note.poll?.choices ?? [],
		renoteCount: note.renoteCount,
		repliesCount: note.repliesCount,

		cw: note.cw ?? null,
		text: note.text ?? '',
		visibility: note.visibility,
		updatedAt: note.updatedAt,
	});

	// bscone: every display's note object of this id, so an edit reaches files/poll of each one
	const notes = new Set<Misskey.entities.Note>([note]);

	// 操作がダブっていないかどうかを簡易的に記録するためのMap
	const reactionUserMap = new Map<Misskey.entities.User['id'], string | typeof noReaction>();
	// The API count already includes my reaction; without this a late `reacted` event for it is counted again.
	if ($i && note.myReaction != null) reactionUserMap.set($i.id, normalizeReactionName(note.myReaction));
	let latestPollVotedKey: string | null = null;

	function onReacted(ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; } | null; }): void {
		const normalizedName = normalizeReactionName(ctx.reaction);
		if (reactionUserMap.has(ctx.userId) && reactionUserMap.get(ctx.userId) === normalizedName) return;
		reactionUserMap.set(ctx.userId, normalizedName);

		if (ctx.emoji && !(ctx.emoji.name in $note.reactionEmojis)) {
			$note.reactionEmojis[ctx.emoji.name] = ctx.emoji.url;
		}

		const currentCount = $note.reactions[normalizedName] || 0;

		$note.reactions[normalizedName] = currentCount + 1;
		$note.reactionCount += 1;

		if ($i && (ctx.userId === $i.id)) {
			$note.myReaction = normalizedName;
		}
	}

	function onUnreacted(ctx: { userId: Misskey.entities.User['id']; reaction: string; emoji?: { name: string; url: string; } | null; }): void {
		const normalizedName = normalizeReactionName(ctx.reaction);

		// 確実に一度リアクションされて取り消されている場合のみ処理をとめる（APIで初回読み込み→Streamでアップデート等の場合、reactionUserMapに情報がないため）
		if (reactionUserMap.has(ctx.userId) && reactionUserMap.get(ctx.userId) === noReaction) return;
		reactionUserMap.set(ctx.userId, noReaction);

		const currentCount = $note.reactions[normalizedName] || 0;

		$note.reactions[normalizedName] = Math.max(0, currentCount - 1);
		$note.reactionCount = Math.max(0, $note.reactionCount - 1);
		if ($note.reactions[normalizedName] === 0) delete $note.reactions[normalizedName];

		if ($i && (ctx.userId === $i.id)) {
			$note.myReaction = null;
		}
	}

	function onPollVoted(ctx: { userId: Misskey.entities.User['id']; choice: number; }): void {
		const newPollVotedKey = `${ctx.userId}:${ctx.choice}`;
		if (newPollVotedKey === latestPollVotedKey) return;
		latestPollVotedKey = newPollVotedKey;

		const choices = [...$note.pollChoices];
		choices[ctx.choice] = {
			...choices[ctx.choice],
			votes: choices[ctx.choice].votes + 1,
			...($i && (ctx.userId === $i.id) ? {
				isVoted: true,
			} : {}),
		};

		$note.pollChoices = choices;
	}

	// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
	function onFetched(data: Pick<Misskey.entities.Note, 'reactions' | 'reactionEmojis'>): void {
		$note.reactions = { ...data.reactions };
		$note.reactionCount = Object.values(data.reactions).reduce((a, b) => a + b, 0);
		$note.reactionEmojis = { ...data.reactionEmojis };
	}

	function onStreamNoteUpdated(noteData: NoteUpdatedEvent): void {
		const { type, id, body } = noteData;

		if (id !== note.id) return;

		switch (type) {
			case 'reacted': {
				noteEvents.emit(`reacted:${id}`, {
					userId: body.userId,
					reaction: body.reaction,
					emoji: body.emoji,
				});
				break;
			}

			case 'unreacted': {
				noteEvents.emit(`unreacted:${id}`, {
					userId: body.userId,
					reaction: body.reaction,
				});
				break;
			}

			case 'pollVoted': {
				noteEvents.emit(`pollVoted:${id}`, {
					userId: body.userId,
					choice: body.choice,
				});
				break;
			}

			case 'deleted': {
				globalEvents.emit('noteDeleted', id);
				break;
			}

			// bscone: note edits
			case 'updated': {
				refetchUpdatedNote(id);
				break;
			}
		}
	}

	function onUpdated(ctx: {
		cw: Misskey.entities.Note['cw'];
		text: Misskey.entities.Note['text'];
		visibility: Misskey.entities.Note['visibility'];
		updatedAt: Misskey.entities.Note['updatedAt'];
		files?: Misskey.entities.DriveFile[];
		fileIds?: string[] | null;
		poll?: Misskey.entities.Note['poll'];
		hasPoll?: boolean;
	}): void {
		if (ctx.cw !== undefined) {
			$note.cw = ctx.cw;
			for (const n of notes) n.cw = ctx.cw;
		}
		if (ctx.text !== undefined) {
			$note.text = ctx.text;
			for (const n of notes) n.text = ctx.text;
		}
		if (ctx.visibility !== undefined) {
			$note.visibility = ctx.visibility;
			for (const n of notes) n.visibility = ctx.visibility;
		}
		if (ctx.updatedAt !== undefined) {
			$note.updatedAt = ctx.updatedAt;
			for (const n of notes) n.updatedAt = ctx.updatedAt;
		}
		// Update files if provided
		if (ctx.files !== undefined) {
			for (const n of notes) n.files = ctx.files;
		}
		if (ctx.fileIds !== undefined) {
			for (const n of notes) n.fileIds = ctx.fileIds ?? [];
		}
		// Update poll if provided
		if (ctx.poll !== undefined) {
			for (const n of notes) n.poll = ctx.poll;
			if (ctx.poll) {
				$note.pollChoices = ctx.poll.choices;
			}
		}
	}

	noteEvents.on(`reacted:${note.id}`, onReacted);
	noteEvents.on(`unreacted:${note.id}`, onUnreacted);
	noteEvents.on(`pollVoted:${note.id}`, onPollVoted);
	noteEvents.on(`noteUpdated:${note.id}`, onUpdated);
	fetchEvent.on(note.id, onFetched);

	return {
		$note,
		refCount: 1,
		realtimeCount: 0,
		notes,
		onStreamNoteUpdated,
		dispose: () => {
			noteEvents.off(`reacted:${note.id}`, onReacted);
			noteEvents.off(`unreacted:${note.id}`, onUnreacted);
			noteEvents.off(`pollVoted:${note.id}`, onPollVoted);
			noteEvents.off(`noteUpdated:${note.id}`, onUpdated);
			fetchEvent.off(note.id, onFetched);
		},
	};
}

function sameReactions(a: Record<string, number>, b: Record<string, number>): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every(k => a[k] === b[k]);
}

// Ids whose displays disagree are collected for one tick so a page mount sends one request.
const pendingSnapshotIds = new Set<string>();

function requestSnapshot(id: string) {
	if (pendingSnapshotIds.size === 0) {
		window.setTimeout(() => {
			const ids = [...pendingSnapshotIds];
			pendingSnapshotIds.clear();
			fetchSnapshotIds(ids);
		}, 0);
	}
	pendingSnapshotIds.add(id);
}

function acquireEntry(note: Misskey.entities.Note): CaptureEntry {
	const entry = captureEntries.get(note.id);
	if (entry == null) {
		const created = createEntry(note);
		captureEntries.set(note.id, created);
		return created;
	}

	entry.refCount++;
	entry.notes.add(note);
	const $note = entry.$note;
	// Counts that only grow on the timescale of a page view: the larger copy is the fresher one.
	$note.renoteCount = Math.max($note.renoteCount, note.renoteCount);
	$note.repliesCount = Math.max($note.repliesCount, note.repliesCount);
	for (const [name, url] of Object.entries(note.reactionEmojis)) {
		if (!(name in $note.reactionEmojis)) $note.reactionEmojis[name] = url;
	}
	// Reactions can also go down, so neither copy can be trusted; ask the server.
	const incoming = normalizeReactions(note.reactions);
	if ($note.reactionCount !== note.reactionCount || !sameReactions($note.reactions, incoming)) {
		requestSnapshot(note.id);
	}
	return entry;
}

function releaseEntry(id: string, entry: CaptureEntry, note?: Misskey.entities.Note) {
	if (note != null) entry.notes.delete(note);
	if (--entry.refCount > 0) return;
	entry.dispose();
	if (captureEntries.get(id) === entry) captureEntries.delete(id);
}

export function useNoteCapture(props: {
	note: Misskey.entities.Note;
	parentNote: Misskey.entities.Note | null;
	mock?: boolean;
}): {
	$note: Reactive<ReactiveNoteData>;
	subscribe: () => void;
} {
	const { note, parentNote, mock } = props;

	// kyunet: fix/note-capture-shared-state
	// Mock notes (tutorials) keep a private state so they never mix with a real note of the same id.
	const entry = mock ? createEntry(note) : acquireEntry(note);
	const $note = entry.$note;

	function subscribe() {
		if (mock) {
			// モックモードでは購読しない
			return;
		}

		if ($i && store.s.realtimeMode) {
			realtimeSubscribe({
				note,
				// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
				// kyunet: fix/note-capture-shared-state
				entry,
			});
		} else {
			pollingSubscribe({
				note,
			});
		}
	}

	// kyunet: fix/note-capture-shared-state
	onUnmounted(() => {
		releaseEntry(note.id, entry, note);
	});

	// 投稿からある程度経過している(=タイムラインを遡って表示した)ノートは、イベントが発生する可能性が低いためそもそも購読しない
	// ただし「リノートされたばかりの過去のノート」(= parentNoteが存在し、かつparentNoteの投稿日時が最近)はイベント発生が考えられるため購読する
	// TODO: デバイスとサーバーの時計がズレていると不具合の元になるため、ズレを検知して警告を表示するなどのケアが必要かもしれない
	if (parentNote == null) {
		if ((Date.now() - new Date(note.createdAt).getTime()) > 1000 * 60 * 5) { // 5min
			// リノートで表示されているノートでもないし、投稿からある程度経過しているので自動で購読しない
			return {
				$note,
				subscribe: () => {
					subscribe();
				},
			};
		}
	} else {
		if ((Date.now() - new Date(parentNote.createdAt).getTime()) > 1000 * 60 * 5) { // 5min
			// リノートで表示されているノートだが、リノートされてからある程度経過しているので自動で購読しない
			return {
				$note,
				subscribe: () => {
					subscribe();
				},
			};
		}
	}

	subscribe();

	return {
		$note,
		subscribe: () => {
			// すでに購読しているので何もしない
		},
	};
}
