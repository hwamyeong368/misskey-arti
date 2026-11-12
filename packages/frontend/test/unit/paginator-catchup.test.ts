/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup - fix/reconnect-catchup-dup-order

import { describe, expect, test, vi } from 'vitest';

const misskeyApi = vi.fn();
vi.mock('@/utility/misskey-api.js', () => ({
	misskeyApi: (...args: unknown[]) => misskeyApi(...args),
}));

const { Paginator } = await import('@/utility/paginator.js');

type Item = { id: string; createdAt: string };

function item(id: string, createdAt = 0): Item {
	return { id, createdAt: new Date(createdAt).toISOString() };
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>(r => { resolve = r; });
	return { promise, resolve };
}

function ids(list: { id: string }[]) {
	return list.map(x => x.id);
}

describe('Paginator catch-up', () => {
	test('fetchNewer with insertById keeps id order when the stream prepends during the request', async () => {
		const p = new Paginator('notes/timeline', {});
		misskeyApi.mockResolvedValueOnce([item('n05'), item('n03')]);
		await p.init();

		const res = deferred<Item[]>();
		misskeyApi.mockReturnValueOnce(res.promise);
		const fetching = p.fetchNewer({ toQueue: false, insertById: true });
		p.prepend(item('n09') as never);
		res.resolve([item('n06'), item('n07'), item('n09')]);
		await fetching;

		expect(ids(p.items.value)).toEqual(['n09', 'n07', 'n06', 'n05', 'n03']);
	});

	test('fetchNewer with insertById into the queue keeps id order', async () => {
		const p = new Paginator('notes/timeline', {});
		misskeyApi.mockResolvedValueOnce([item('n05'), item('n03')]);
		await p.init();

		const res = deferred<Item[]>();
		misskeyApi.mockReturnValueOnce(res.promise);
		const fetching = p.fetchNewer({ toQueue: true, insertById: true });
		p.enqueue(item('n09') as never);
		res.resolve([item('n06'), item('n07'), item('n09')]);
		await fetching;
		p.releaseQueue();

		expect(ids(p.items.value)).toEqual(['n09', 'n07', 'n06', 'n05', 'n03']);
	});

	test('refreshHead replaces a grouped head instead of stacking a second group', async () => {
		const p = new Paginator('i/notifications-grouped', {});
		// group of A, B carries the id of its oldest member A
		misskeyApi.mockResolvedValueOnce([item('a01', 2000), item('x00', 500)]);
		await p.init();

		misskeyApi.mockResolvedValueOnce([item('a01', 3000), item('x00', 500)]);
		await p.refreshHead();

		expect(ids(p.items.value)).toEqual(['a01', 'x00']);
	});

	test('refreshHead keeps notifications streamed in after the server snapshot, drops ones it covers', async () => {
		const p = new Paginator('i/notifications-grouped', {});
		misskeyApi.mockResolvedValueOnce([item('a01', 2000)]);
		await p.init();

		const res = deferred<Item[]>();
		misskeyApi.mockReturnValueOnce(res.promise);
		const refreshing = p.refreshHead();
		p.prepend(item('c03', 3000) as never); // already folded into the a01 group by the server
		p.prepend(item('d04', 4000) as never); // newer than the snapshot
		res.resolve([item('a01', 3000)]);
		await refreshing;

		expect(ids(p.items.value)).toEqual(['d04', 'a01']);
	});
});
