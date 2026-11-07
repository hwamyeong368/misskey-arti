/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Exercise the original functions with mocked I/O; no database, browser or FFmpeg is started.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = file => fs.readFileSync(new URL(file, root), 'utf8').replace(/\r\n/g, '\n');
const frontend = read('packages/frontend/src/utility/voice-call.ts');
const livekit = read('packages/backend/src/core/LiveKitService.ts');
const compile = (code, globals = {}) => vm.runInNewContext(stripTypeScriptTypes(`(${code})`), globals);
const method = (source, name) => {
	const start = source.indexOf(`public async ${name}`);
	const end = source.indexOf('\n\t@bindThis', start);
	assert.ok(start >= 0 && end > start);
	return source.slice(start, end).replace(`public async ${name}`, `async function ${name}`).trim();
};

test('muting immediately silences the independent recording microphone', async () => {
	const track = { enabled: true };
	let release;
	const room = { localParticipant: { setMicrophoneEnabled: () => new Promise(resolve => { release = resolve; }) } };
	const context = { current: room, state: { micEnabled: true }, recordingRawMicStream: { getAudioTracks: () => [track] }, captureOptions: () => ({}), stopLocalMeter: null, unwatchMicrophoneTrack: null, reportStatus: () => {} };
	vm.createContext(context);
	const helper = frontend.slice(frontend.indexOf('function setRecordingMicrophoneEnabled'), frontend.indexOf('// undeafenAt:'));
	const source = frontend.slice(frontend.indexOf('async function disableMicrophone'), frontend.indexOf('// audio 要素', frontend.indexOf('async function disableMicrophone')));
	const pending = vm.runInContext(stripTypeScriptTypes(`${helper}\n${source}\ndisableMicrophone(current)`), context);
	assert.equal(track.enabled, false);
	release();
	await pending;
	assert.equal(context.state.micEnabled, false);
});

test('failed microphone activation never enables the recording input', async () => {
	const track = { enabled: false };
	const room = { localParticipant: { setMicrophoneEnabled: async () => { throw new Error('Permission denied'); } } };
	const context = { current: room, state: { micEnabled: false }, recordingRawMicStream: { getAudioTracks: () => [track] }, captureOptions: () => ({}), stopLocalMeter: null, reportStatus: () => {}, os: { toast: () => {} }, i18n: { ts: { _voiceCall: {} } } };
	vm.createContext(context);
	const helper = frontend.slice(frontend.indexOf('function setRecordingMicrophoneEnabled'), frontend.indexOf('// undeafenAt:'));
	const source = frontend.slice(frontend.indexOf('async function enableMicrophone'), frontend.indexOf('async function disableMicrophone'));
	await vm.runInContext(stripTypeScriptTypes(`${helper}\n${source}\nenableMicrophone(current)`), context);
	assert.equal(track.enabled, false);
});

test('owner mute also disables the independent recording microphone', () => {
	const track = { enabled: true };
	const participant = {};
	const context = { state: { micEnabled: true }, recordingRawMicStream: { getAudioTracks: () => [track] }, isCurrent: () => true, room: { localParticipant: participant }, Track: { Source: { Microphone: 'microphone' } }, stopLocalMeter: null, reportStatus: () => {} };
	vm.createContext(context);
	const helper = frontend.slice(frontend.indexOf('function setRecordingMicrophoneEnabled'), frontend.indexOf('// undeafenAt:'));
	const start = frontend.indexOf('room.on(RoomEvent.TrackMuted, ');
	const end = frontend.indexOf('\n\t});', start);
	const callback = frontend.slice(start + 'room.on(RoomEvent.TrackMuted, '.length, end) + '\n}';
	vm.runInContext(stripTypeScriptTypes(helper), context);
	const handle = vm.runInContext(stripTypeScriptTypes(`(${callback})`), context);
	handle({ source: 'microphone' }, participant);
	assert.equal(context.state.micEnabled, false);
	assert.equal(track.enabled, false);
});

test('recording state is stored, explicit false clears it, and unsupported clients leave it unchanged', async () => {
	let written;
	const service = { getParticipant: async () => ({ sid: 'session' }), updateParticipant: async (_r, _u, value) => { written = value; return { sid: 'session' }; } };
	const receiver = { requireRoomService: () => service, roomNameOf: value => value };
	const update = compile(method(livekit, 'setParticipantStatus'), { isNotFound: () => false });
	for (const recording of [true, false, undefined]) {
		await update.call(receiver, 'room', 'user', 'session', { micMuted: false, deafened: false, recording });
		assert.equal(written.attributes['cherrypick.recording'], recording == null ? undefined : String(recording));
	}
	service.getParticipant = async () => ({ sid: 'new-session' });
	written = null;
	assert.equal(await update.call(receiver, 'room', 'user', 'old-session', { micMuted: false, deafened: false, recording: true }), false);
	assert.equal(written, null);
});

test('participant snapshots expose the stored recording state', async () => {
	const list = compile(method(livekit, 'listParticipants'), { userIdOfMetadata: () => 'user', TrackSource: { MICROPHONE: 'microphone', SCREEN_SHARE: 'screen' }, parseReportedBoolean: value => value === 'true', reportedVoiceStatus: value => value });
	const participants = await list.call({ requireRoomService: () => ({ listParticipants: async () => [{ identity: 'user', joinedAt: 1n, tracks: [], attributes: { 'cherrypick.recording': 'true' } }] }), roomNameOf: value => value }, 'room');
	assert.equal(participants[0].recording, true);
});

test('remote call policy rejects a join before any remote request', async () => {
	const source = read('packages/backend/src/core/RemoteVoiceCallService.ts');
	const join = compile(method(source, 'requestJoin'), { RemoteVoiceCallError: Error });
	let requested = false;
	await assert.rejects(join.call({ isEnabled: false, trustedOwnerUrlOf: async () => { requested = true; } }, {}, {}, {}, false));
	assert.equal(requested, false);
});

function conversionHarness() {
	const source = read('packages/backend/src/server/api/endpoints/chat/rooms/voice/convert-recording.ts');
	const start = source.indexOf('async (ps, me) => {');
	const end = source.indexOf('\n\t\t});', start);
	const calls = [];
	let locked = false;
	const globals = {
		fs: { mkdtempSync: () => '/mock-tmp', rmSync: () => calls.push('cleanup'), statSync: () => ({ size: 4096 }) },
		os: { tmpdir: () => '/tmp' }, Path: path, randomUUID: () => 'lease',
		CONVERSION_LOCK: 'conversion', CONVERSION_LOCK_MS: 180000, CONVERSION_TIMEOUT_MS: 90000,
		MAX_RECORDING_BYTES: 128 * 1024 * 1024, RELEASE_LOCK_SCRIPT: 'compare-and-delete',
		meta: { errors: { conversionFailed: 'conversion failed', noSuchFile: 'not found' } }, ApiError: Error,
		AbortController, setInterval: () => ({ unref: () => {} }), clearInterval: () => {},
		execFileAsync: async (command, args, options) => {
			calls.push({ command, args, options });
			return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 1920, height: 1080 }], format: { duration: '60' } }) };
		},
	};
	const receiver = {
		driveFilesRepository: { findOneBy: async () => ({ id: 'file', userId: 'user', size: 4096, storedInternal: true, accessKey: 'key', type: 'video/webm', name: 'test.webm', isSensitive: true, folderId: 'folder' }) },
		redisClient: { set: async () => { if (locked) return null; locked = true; return 'OK'; }, eval: async () => { locked = false; calls.push('unlock'); } },
		internalStorageService: { resolvePath: () => '/mock-input' },
		driveService: { addFile: async value => { calls.push({ saved: value }); return { id: 'converted' }; }, deleteFile: async () => calls.push('delete-original') },
		driveFileEntityService: { pack: async value => value },
	};
	const fn = compile((source.slice(start, end) + '}').replace('async (ps, me) =>', 'async function (ps, me)'), globals);
	return { calls, globals, receiver, run: () => fn.call(receiver, { fileId: 'file' }, { id: 'user' }) };
}

test('conversion limits processes and releases the lease after success', async () => {
	const harness = conversionHarness();
	await harness.run();
	const process = harness.calls.find(call => call.command === 'ffmpeg');
	assert.equal(process.options.timeout, 90000);
	assert.equal(process.options.killSignal, 'SIGKILL');
	for (const flag of ['-threads', '-protocol_whitelist']) assert.ok(process.args.includes(flag));
	for (const flag of ['-t', '-fs']) assert.equal(process.args.includes(flag), false);
	const saved = harness.calls.find(call => call.saved).saved;
	assert.equal(saved.force, undefined);
	assert.equal(saved.sensitive, true);
	assert.equal(saved.folderId, 'folder');
	assert.deepEqual(harness.calls.slice(-3), ['delete-original', 'cleanup', 'unlock']);
});

test('a busy conversion rejects another request without starting a process', async () => {
	const harness = conversionHarness();
	harness.receiver.redisClient.set = async () => null;
	await assert.rejects(harness.run());
	assert.equal(harness.calls.length, 0);
});

test('failed conversion preserves the original and releases the lease', async () => {
	const harness = conversionHarness();
	harness.globals.execFileAsync = async () => { throw new Error('bad media'); };
	await assert.rejects(harness.run());
	assert.deepEqual(harness.calls, ['cleanup', 'unlock']);
});

test('unknown input duration cannot silently truncate or delete a long recording', async () => {
	const harness = conversionHarness();
	harness.globals.execFileAsync = async (command, args) => {
		if (command === 'ffmpeg') {
			assert.equal(args.includes('-t'), false);
			assert.equal(args.includes('-fs'), false);
			return { stdout: '' };
		}
		return { stdout: JSON.stringify(args.includes('-protocol_whitelist') ? { streams: [] } : { format: { duration: '1801' } }) };
	};
	await assert.rejects(harness.run());
	assert.deepEqual(harness.calls, ['cleanup', 'unlock']);
});

test('oversized output is rejected without deleting the original', async () => {
	const harness = conversionHarness();
	harness.globals.fs.statSync = () => ({ size: 129 * 1024 * 1024 });
	await assert.rejects(harness.run());
	assert.equal(harness.calls.includes('delete-original'), false);
	assert.equal(harness.calls.at(-1), 'unlock');
});
