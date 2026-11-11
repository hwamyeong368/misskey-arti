/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { setTimeout } from 'node:timers/promises';
import { beforeAll, describe, test } from 'vitest';
import { api, post, signup } from '../utils.js';
import type * as misskey from 'misskey-js';

// arti: mentions from people I neither follow nor am followed by go to the separate requests box
describe('Notification requests', () => {
	let alice: misskey.entities.SignupResponse;
	let friend: misskey.entities.SignupResponse;
	let stranger: misskey.entities.SignupResponse;

	const hasFrom = (list: misskey.entities.Notification[], userId: string) => list.some(n => 'userId' in n && n.userId === userId);

	beforeAll(async () => {
		alice = await signup({ username: 'nr_alice' });
		friend = await signup({ username: 'nr_friend' });
		stranger = await signup({ username: 'nr_stranger' });
		await api('following/create', { userId: friend.id }, alice);
		await api('i/update', { notificationRequestsEnabled: true }, alice);
	}, 1000 * 60 * 2);

	test('a stranger\'s mention lands in requests, a friend\'s in notifications', async () => {
		await post(friend, { text: '@nr_alice hi from friend' });
		await post(stranger, { text: '@nr_alice hi from stranger' });
		await setTimeout(500);

		const main = await api('i/notifications', {}, alice);
		assert.strictEqual(main.status, 200);
		assert.strictEqual(hasFrom(main.body, friend.id), true);
		assert.strictEqual(hasFrom(main.body, stranger.id), false);

		const requests = await api('i/notification-requests/list', {}, alice);
		assert.strictEqual(requests.status, 200);
		assert.strictEqual(hasFrom(requests.body, stranger.id), true);
		assert.strictEqual(hasFrom(requests.body, friend.id), false);
	});

	test('allowing a stranger clears their requests and lets later notifications through', async () => {
		const allow = await api('i/notification-requests/allow', { userId: stranger.id }, alice);
		assert.strictEqual(allow.status, 204);

		const requests = await api('i/notification-requests/list', {}, alice);
		assert.strictEqual(hasFrom(requests.body, stranger.id), false);

		await post(stranger, { text: '@nr_alice again' });
		await setTimeout(500);
		const main = await api('i/notifications', {}, alice);
		assert.strictEqual(hasFrom(main.body, stranger.id), true);
	});

	test('the setting is off by default', async () => {
		const me = await api('i', {}, friend);
		assert.strictEqual(me.body.notificationRequestsEnabled, false);
	});
});
