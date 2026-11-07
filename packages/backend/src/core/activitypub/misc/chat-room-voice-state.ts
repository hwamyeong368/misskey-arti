/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { reportedVoiceStatus } from '@/core/voice-participant-status.js';
import type { IObject } from '../type.js';

const ROOM_ID = /^[a-zA-Z0-9]+$/;

export type ParsedChatRoomVoiceState = {
	roomId: string;
	participants: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean; recording?: boolean }[];
	updatedAt: number;
};

export type ChatRoomVoiceStateParseResult =
	| { ok: true; state: ParsedChatRoomVoiceState }
	| { ok: false; reason: string };

/** arti: the id of a room's voice state, on the server that owns the room */
export function chatRoomVoiceStateIdOf(roomUri: string): string {
	return `${roomUri}/voice`;
}

/** arti: validate a ChatRoomVoiceState received from the owner of a mirror room */
export function parseChatRoomVoiceState(actorUri: string, object: IObject, maxParticipants: number): ChatRoomVoiceStateParseResult {
	const state = object as IObject & { room?: unknown; participants?: unknown; updated?: unknown };
	if (typeof state.id !== 'string' || typeof state.room !== 'string') return refuse('invalid voice state');

	const origin = originOf(actorUri);
	if (origin == null || originOf(state.id) !== origin || originOf(state.room) !== origin) {
		return refuse('voice state is not on the sender\'s server');
	}

	const roomId = roomIdOfUri(state.room, origin);
	if (roomId == null) return refuse('invalid room URI');
	if (state.id !== chatRoomVoiceStateIdOf(state.room)) return refuse('voice state id does not belong to the room');

	const participants = parseParticipants(state.participants, maxParticipants);
	if (participants == null) return refuse('invalid participants');

	const updatedAt = typeof state.updated === 'string' ? Date.parse(state.updated) : NaN;
	if (!Number.isFinite(updatedAt)) return refuse('invalid updated');

	return { ok: true, state: { roomId, participants, updatedAt } };
}

function refuse(reason: string): ChatRoomVoiceStateParseResult {
	return { ok: false, reason };
}

function originOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
	} catch {
		return null;
	}
}

function roomIdOfUri(uri: string, origin: string): string | null {
	const prefix = `${origin}/chat/rooms/`;
	if (!uri.startsWith(prefix)) return null;
	const roomId = uri.slice(prefix.length);
	return ROOM_ID.test(roomId) ? roomId : null;
}

function parseParticipants(value: unknown, maxParticipants: number): { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean; recording?: boolean }[] | null {
	if (!Array.isArray(value) || value.length > maxParticipants) return null;

	const parsed: { identity: string; screenSharing: boolean; micMuted?: boolean; deafened?: boolean; recording?: boolean }[] = [];
	for (const participant of value as unknown[]) {
		if (typeof participant !== 'object' || participant == null) return null;
		const { id, screenSharing } = participant as Record<string, unknown>;
		if (typeof id !== 'string' || typeof screenSharing !== 'boolean') return null;
		parsed.push({ identity: id, screenSharing, ...reportedVoiceStatus(participant as Record<string, unknown>) });
	}
	return parsed;
}
