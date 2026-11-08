/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as Vue from 'vue';
import * as renderer from 'vue/server-renderer';
import { compileTemplate, parse } from 'vue/compiler-sfc';

async function renderIndicator(file: string, recording: boolean): Promise<string> {
	const filename = new URL(`../src/pages/chat/room.voice.${file}.vue`, import.meta.url);
	const { descriptor } = parse(readFileSync(filename, 'utf8'));
	const result = compileTemplate({ source: descriptor.template!.content, filename: filename.pathname, id: 'recording-test', ssr: true });
	expect(result.errors).toEqual([]);
	const code = result.code.replace(/^import \{([^}]+)\} from "([^"]+)"/gm, (_match, bindings: string, moduleName: string) => {
		return `const {${bindings.replace(/ as /g, ': ')}} = modules[${JSON.stringify(moduleName)}]`;
	}).replace('export function ssrRender', 'return function ssrRender');
	const ssrRender = new Function('modules', code)({ vue: Vue, 'vue/server-renderer': renderer });
	const participant = { identity: 'user', user: { id: 'user', name: 'Tester' }, recording, micMuted: false, deafened: false };
	const app = Vue.createSSRApp({
		ssrRender,
		setup: () => ({
			participant, rows: [{ p: participant, menuable: false }], speaking: false, menuable: false,
			modal: null, headingId: 'heading',
			recording, room: { id: 'room' }, rootEl: null, screensEl: null,
			watchedParticipants: [{}], membersHidden: true, active: false, menuOpen: false,
			showsStatus: false, announcesStatus: false, voiceCallStatusText: 'In call',
			prefer: { s: { animation: false } }, shownShares: [], shown: [], hidden: [],
			availableShares: [], grouped: [], inThisCall: true, isOwner: false,
			cardStyle: {}, screenStyle: {}, showControls: () => {}, trackHover: () => {},
			i18n: { ts: { _voiceCall: { recording: '녹음 중' }, _chat: { members: 'Members' }, close: 'Close' } },
			userNameForLabel: () => 'Tester',
		}),
	});
	app.config.globalProperties.$style = new Proxy({}, { get: (_target, key) => String(key) });
	app.component('MkAvatar', { render: () => null });
	app.component('MkUserName', { render: () => Vue.h('span', 'Tester') });
	app.component('MkModal', { render() { return this.$slots.default?.(); } });
	for (const name of ['XScreens', 'XControls', 'XBanner']) app.component(name, { render: () => null });
	app.directive('tooltip', { getSSRProps: () => ({}) });
	return renderer.renderToString(app);
}

describe.each(['tile', 'roster', 'stage'])('recording indicator in %s', file => {
	test('shows a recording label while active', async () => {
		expect(await renderIndicator(file, true)).toContain('녹음 중');
	});
	test('removes the recording label when stopped', async () => {
		expect(await renderIndicator(file, false)).not.toContain('녹음 중');
	});
});
