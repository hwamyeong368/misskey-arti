/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup

import { describe, expect, test, vi } from 'vitest';
import type * as Misskey from 'misskey-js';

const misskeyApi = vi.fn();
vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: (...args: unknown[]) => misskeyApi(...args),
}));
vi.mock('@/i.js', () => ({
	$i: { id: 'me' },
}));
vi.mock('@/store.js', () => ({
	store: { s: { realtimeMode: true } },
}));
vi.mock('@/stream.js', () => ({
	useStream: () => ({ on: vi.fn(), off: vi.fn(), send: vi.fn() }),
}));

const { useNoteCapture, noteEvents } = await import('@/composables/use-note-capture.js');
const { globalEvents } = await import('@/events.js');

function makeNote(id: string): Misskey.entities.Note {
	return {
		id,
		createdAt: new Date().toISOString(),
		reactions: {},
		reactionCount: 0,
		reactionEmojis: {},
		myReaction: null,
	} as unknown as Misskey.entities.Note;
}

describe('useNoteCapture', () => {
	test('a snapshot does not make subscribers of the same note share one reactions object', async () => {
		const note = makeNote('n1');
		const a = useNoteCapture({ note, parentNote: null }).$note;
		const b = useNoteCapture({ note, parentNote: null }).$note;

		misskeyApi.mockResolvedValueOnce([{ id: 'n1', reactions: { '👍': 1 }, reactionEmojis: {} }]);
		globalEvents.emit('streamReconnected');
		await vi.waitFor(() => expect(a.reactions['👍']).toBe(1));
		expect(b.reactions['👍']).toBe(1);

		noteEvents.emit('reacted:n1', { userId: 'u2', reaction: '👍' });

		expect(a.reactions['👍']).toBe(2);
		expect(b.reactions['👍']).toBe(2);
	});
});
