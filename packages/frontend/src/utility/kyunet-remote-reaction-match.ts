/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// kyunet: feat/remote-reaction-to-local
// Decides whether a remote custom-emoji reaction (`:name@host:`) may be re-sent as the
// local emoji of the same name. Both images go through the same-origin proxy (the file
// server sends no CORS headers) and are compared pixel-wise. The guard only has to stop
// a different picture under a generic name; thresholds and measurements are in FORK-SPEC.md.

import { customEmojisMap } from '@/custom-emojis.js';
import { getProxiedImageUrl } from '@/utility/media-proxy.js';

// Drawn at the proxy's own height and reduced in code: letting drawImage downscale made
// the score depend on the browser's resampler.
const DRAW_SIZE = 128;
const SIZE = 32;
const BLOCK = DRAW_SIZE / SIZE;
const MAX_MEAN_ABS_DIFF = 4;
const MAX_ASPECT_DIFF = 0.02;
// The pixel check sees only the first frame, so speed variants are told apart by total length.
const MAX_DURATION_DIFF_RATIO = 0.25;
const MAX_DURATION_DIFF_MS = 50;
// Browsers play delays this short as 100 ms and some encoders write them as 100 ms.
const MIN_FRAME_DELAY_MS = 20;
const NORMALISED_FRAME_DELAY_MS = 100;

type ContainerInfo = {
	animated: boolean;
	/** Sum of frame delays after normalisation; null when static or when the frames could not be read. */
	durationMs: number | null;
};

type ImageInfo = ContainerInfo & {
	fp: Float32Array;
	width: number;
	height: number;
};

const cache = new Map<string, Promise<string | null>>();

/** True for `:name@host:` with a real host (local reactions arrive as `:name@.:`). */
export function isRemoteCustomEmojiReaction(reaction: string): boolean {
	return reaction[0] === ':' && !reaction.includes('@.');
}

/**
 * Remote reaction string (`:name@host:`) -> local reaction string (`:name@.:`) when the
 * local emoji with the same name exists. Does not check the image.
 */
export function getLocalCounterpartReaction(reaction: string): string | null {
	const match = reaction.match(/^:([\w+-]+)@([\w.-]+):$/);
	if (match == null || match[2] === '.') return null;
	return customEmojisMap.has(match[1]) ? `:${match[1]}@.:` : null;
}

/**
 * Resolves to the local reaction string when the remote image matches the local emoji
 * image, otherwise null. Any failure (network, unknown container, canvas) resolves to null.
 */
export function resolveRemoteReactionToLocal(reaction: string, remoteUrl: string | undefined): Promise<string | null> {
	const local = getLocalCounterpartReaction(reaction);
	if (local == null || remoteUrl == null) return Promise.resolve(null);
	const localUrl = customEmojisMap.get(reaction.slice(1, reaction.indexOf('@')))?.url;
	if (localUrl == null) return Promise.resolve(null);

	// The local URL is part of the key so a replaced local image invalidates the entry.
	const key = `${reaction}\n${localUrl}`;
	let pending = cache.get(key);
	if (pending == null) {
		pending = compare(remoteUrl, localUrl).then(same => same ? local : null).catch(() => null);
		cache.set(key, pending);
	}
	return pending;
}

async function compare(remoteUrl: string, localUrl: string): Promise<boolean> {
	const [a, b] = await Promise.all([load(remoteUrl), load(localUrl)]);
	if (a == null || b == null) return false;
	if (a.animated !== b.animated) return false;
	if (a.durationMs != null && b.durationMs != null) {
		const tolerance = Math.max(MAX_DURATION_DIFF_RATIO * Math.max(a.durationMs, b.durationMs), MAX_DURATION_DIFF_MS);
		if (Math.abs(a.durationMs - b.durationMs) > tolerance) return false;
	}
	if (Math.abs(a.width / a.height - b.width / b.height) > MAX_ASPECT_DIFF) return false;
	let sum = 0;
	for (let i = 0; i < a.fp.length; i++) sum += Math.abs(a.fp[i] - b.fp[i]);
	return sum / a.fp.length <= MAX_MEAN_ABS_DIFF;
}

async function load(url: string): Promise<ImageInfo | null> {
	const res = await window.fetch(getProxiedImageUrl(url, 'emoji', true, true));
	if (!res.ok) return null;
	const blob = await res.blob();
	const container = sniffContainer(new Uint8Array(await blob.arrayBuffer()));
	if (container == null) return null;
	const bitmap = await window.createImageBitmap(blob);
	try {
		const canvas = new OffscreenCanvas(DRAW_SIZE, DRAW_SIZE);
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (ctx == null) return null;
		ctx.drawImage(bitmap, 0, 0, DRAW_SIZE, DRAW_SIZE);
		const data = ctx.getImageData(0, 0, DRAW_SIZE, DRAW_SIZE).data;
		// premultiply so the colour of fully transparent pixels does not count
		const fp = new Float32Array(SIZE * SIZE * 4);
		for (let y = 0; y < DRAW_SIZE; y++) {
			for (let x = 0; x < DRAW_SIZE; x++) {
				const i = (y * DRAW_SIZE + x) * 4;
				const o = (Math.floor(y / BLOCK) * SIZE + Math.floor(x / BLOCK)) * 4;
				const alpha = data[i + 3] / 255;
				fp[o] += data[i] * alpha;
				fp[o + 1] += data[i + 1] * alpha;
				fp[o + 2] += data[i + 2] * alpha;
				fp[o + 3] += data[i + 3];
			}
		}
		for (let i = 0; i < fp.length; i++) fp[i] /= BLOCK * BLOCK;
		return { fp, width: bitmap.width, height: bitmap.height, ...container };
	} finally {
		bitmap.close();
	}
}

/**
 * Only WebP and APNG are understood (the proxy emits WebP and passes APNG through).
 * Null for anything else fails closed; unreadable frames only skip the length check.
 */
function sniffContainer(bytes: Uint8Array): ContainerInfo | null {
	const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
	const normalise = (delayMs: number) => delayMs <= MIN_FRAME_DELAY_MS ? NORMALISED_FRAME_DELAY_MS : delayMs;
	if (bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
		let animated = false;
		let frames = 0;
		let durationMs = 0;
		let p = 12;
		while (p + 8 <= bytes.length) {
			const tag = ascii(p, 4);
			const size = bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16) | (bytes[p + 7] << 24);
			if (tag === 'VP8X') animated = (bytes[p + 8] & 0x02) !== 0;
			if (tag === 'ANMF' && p + 24 <= bytes.length) {
				// ANMF payload: x(3) y(3) w-1(3) h-1(3) duration(3) flags(1)
				frames++;
				durationMs += normalise(bytes[p + 20] | (bytes[p + 21] << 8) | (bytes[p + 22] << 16));
			}
			p += 8 + size + (size & 1);
		}
		// simple (VP8/VP8L only) file: never animated
		return { animated, durationMs: animated && frames > 0 ? durationMs : null };
	}
	if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
		let animated = false;
		let frames = 0;
		let durationMs = 0;
		let p = 8;
		while (p + 8 <= bytes.length) {
			const size = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
			const tag = ascii(p + 4, 4);
			if (tag === 'acTL') animated = true;
			if (tag === 'fcTL' && p + 34 <= bytes.length) {
				// fcTL payload: seq(4) w(4) h(4) x(4) y(4) delay_num(2) delay_den(2) dispose(1) blend(1)
				frames++;
				const num = (bytes[p + 28] << 8) | bytes[p + 29];
				const den = ((bytes[p + 30] << 8) | bytes[p + 31]) || 100;
				durationMs += normalise(1000 * num / den);
			}
			if (tag === 'IEND') break;
			p += 12 + size;
		}
		return { animated, durationMs: animated && frames > 0 ? Math.round(durationMs) : null };
	}
	return null;
}
