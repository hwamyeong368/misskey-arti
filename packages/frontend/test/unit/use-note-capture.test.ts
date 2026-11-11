/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
// kyunet: fix/note-capture-shared-state

import { describe, expect, test, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { render } from '@testing-library/vue';
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
const streamHandlers = new Set<(ev: unknown) => void>();
vi.mock('@/stream.js', () => ({
	useStream: () => ({
		on: (type: string, fn: (ev: unknown) => void) => { if (type === 'noteUpdated') streamHandlers.add(fn); },
		off: (type: string, fn: (ev: unknown) => void) => { if (type === 'noteUpdated') streamHandlers.delete(fn); },
		send: vi.fn(),
	}),
}));

const { useNoteCapture, noteEvents } = await import('@/composables/use-note-capture.js');
const { globalEvents } = await import('@/events.js');

function makeNote(id: string, extra: Partial<Misskey.entities.Note> = {}): Misskey.entities.Note {
	return {
		id,
		createdAt: new Date().toISOString(),
		reactions: {},
		reactionCount: 0,
		reactionEmojis: {},
		myReaction: null,
		renoteCount: 0,
		repliesCount: 0,
		...extra,
	} as unknown as Misskey.entities.Note;
}

// mounts a component so onUnmounted hooks run on unmount()
function mountCapture(note: Misskey.entities.Note) {
	let $note!: ReturnType<typeof useNoteCapture>['$note'];
	const view = render(defineComponent({
		setup() {
			$note = useNoteCapture({ note, parentNote: null }).$note;
			return () => h('div');
		},
	}));
	return { $note, unmount: view.unmount };
}

function streamEmit(ev: unknown) {
	for (const fn of [...streamHandlers]) fn(ev);
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

	test('two displays of one note with different baselines converge on the server snapshot', async () => {
		const a = mountCapture(makeNote('n2', { reactions: { '👍': 1 }, reactionCount: 1 }));
		misskeyApi.mockImplementation(async (ep: string, data: { noteIds: string[] }) => {
			if (ep === 'notes/show-partial-bulk' && data.noteIds.includes('n2')) {
				return [{ id: 'n2', reactions: { '👍': 3 }, reactionEmojis: {} }];
			}
			return [];
		});
		const b = mountCapture(makeNote('n2', { reactions: { '👍': 3 }, reactionCount: 3 }));

		await vi.waitFor(() => expect(a.$note.reactions['👍']).toBe(3));
		expect(b.$note.reactionCount).toBe(3);

		noteEvents.emit('reacted:n2', { userId: 'u9', reaction: '👍' });
		expect(a.$note.reactions['👍']).toBe(4);
		expect(b.$note.reactions['👍']).toBe(4);
		misskeyApi.mockReset();
		a.unmount();
		b.unmount();
	});

	test('a late stream event for my reaction already in the baseline is not counted again', () => {
		const a = mountCapture(makeNote('n3', { reactions: { '👍': 1 }, reactionCount: 1, myReaction: '👍' }));
		streamEmit({ type: 'reacted', id: 'n3', body: { userId: 'me', reaction: '👍' } });
		expect(a.$note.reactions['👍']).toBe(1);
		expect(a.$note.reactionCount).toBe(1);
		a.unmount();
	});

	test('one stream event is counted once however many displays subscribe', () => {
		const a = mountCapture(makeNote('n4'));
		const b = mountCapture(makeNote('n4'));
		const c = mountCapture(makeNote('n4'));
		streamEmit({ type: 'reacted', id: 'n4', body: { userId: 'u1', reaction: '👍' } });
		streamEmit({ type: 'unreacted', id: 'n4', body: { userId: 'u1', reaction: '👍' } });
		streamEmit({ type: 'reacted', id: 'n4', body: { userId: 'u1', reaction: '🎉' } });
		expect(a.$note.reactions).toEqual({ '🎉': 1 });
		expect(c.$note.reactionCount).toBe(1);
		a.unmount();
		b.unmount();
		c.unmount();
	});

	test('a fresher copy of the note raises renote and reply counts everywhere', () => {
		const a = mountCapture(makeNote('n5', { renoteCount: 1, repliesCount: 2 }));
		const b = mountCapture(makeNote('n5', { renoteCount: 3, repliesCount: 2 }));
		expect(a.$note.renoteCount).toBe(3);
		expect(b.$note.renoteCount).toBe(3);
		const c = mountCapture(makeNote('n5', { renoteCount: 2, repliesCount: 4 }));
		expect(a.$note.renoteCount).toBe(3);
		expect(a.$note.repliesCount).toBe(4);
		a.unmount();
		b.unmount();
		c.unmount();
	});

	test('the shared state is dropped once the last display unmounts', () => {
		const handlersBefore = streamHandlers.size;
		const a = mountCapture(makeNote('n6', { reactions: { '👍': 1 }, reactionCount: 1 }));
		expect(streamHandlers.size).toBe(handlersBefore + 1);
		a.unmount();
		expect(streamHandlers.size).toBe(handlersBefore);
		const b = mountCapture(makeNote('n6', { reactions: { '👍': 5 }, reactionCount: 5 }));
		expect(b.$note.reactions['👍']).toBe(5);
		b.unmount();
	});
});
