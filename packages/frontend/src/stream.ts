/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Misskey from 'misskey-js';
import { markRaw } from 'vue';
import { $i } from '@/i.js';
// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
import { globalEvents } from '@/events.js';
import { wsOrigin } from '@@/js/config.js';

// heart beat interval in ms
const HEART_BEAT_INTERVAL = 1000 * 60;

let stream: Misskey.IStream | null = null;
let timeoutHeartBeat: number | null = null;
let lastHeartbeatCall = 0;

export function useStream(): Misskey.IStream {
	if (stream) return stream;

	stream = markRaw(new Misskey.Stream(wsOrigin, $i ? {
		token: $i.token,
	} : null));

	if (timeoutHeartBeat) window.clearTimeout(timeoutHeartBeat);
	timeoutHeartBeat = window.setTimeout(heartbeat, HEART_BEAT_INTERVAL);

	// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
	// The first _connected_ after boot is not a reconnect; only a _connected_ that follows a _disconnected_ emits.
	let wasDisconnected = false;
	stream.on('_disconnected_', () => {
		wasDisconnected = true;
	});
	stream.on('_connected_', () => {
		if (!wasDisconnected) return;
		wasDisconnected = false;
		globalEvents.emit('streamReconnected');
	});

	// send heartbeat right now when last send time is over HEART_BEAT_INTERVAL
	window.document.addEventListener('visibilitychange', () => {
		if (
			!stream
			|| window.document.visibilityState !== 'visible'
			|| Date.now() - lastHeartbeatCall < HEART_BEAT_INTERVAL
		) return;
		heartbeat();
	});

	// kyunet: feat/improve_serverDisconnectedBehavior - feat/stream-reconnect-catchup
	// When the browser regains connectivity, probe the socket right away instead of waiting for the next
	// interval: a write on a socket the server already dropped fails and triggers the normal reconnect.
	window.addEventListener('online', () => {
		if (!stream) return;
		heartbeat();
	});

	return stream;
}

function heartbeat(): void {
	if (stream != null && window.document.visibilityState === 'visible') {
		stream.heartbeat();
	}
	lastHeartbeatCall = Date.now();
	if (timeoutHeartBeat) window.clearTimeout(timeoutHeartBeat);
	timeoutHeartBeat = window.setTimeout(heartbeat, HEART_BEAT_INTERVAL);
}
