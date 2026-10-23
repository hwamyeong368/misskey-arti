/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// kyunet: feat/remote-reaction-to-local
// Decides whether a remote custom-emoji reaction (`:name@host:`) may be re-sent as the
// local emoji of the same name. Both images are fetched through the same-origin proxy
// (the file server sends no CORS headers in production) and compared pixel-wise after
// the proxy has normalised them (height 128, WebP). Thresholds were calibrated on the
// kyunet emoji set on 2026-10-23: byte-identical copies score 0, same-size lossy
// re-encodes score ~1.3 (p95 2.7), a changed eye shape scores ~2.3.

import { customEmojisMap } from '@/custom-emojis.js';
import { getProxiedImageUrl } from '@/utility/media-proxy.js';

const SIZE = 32;
const MAX_MEAN_ABS_DIFF = 1.5;
const MAX_ASPECT_DIFF = 0.02;

type ImageInfo = {
	fp: Float32Array;
	width: number;
	height: number;
	animated: boolean;
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
	if (Math.abs(a.width / a.height - b.width / b.height) > MAX_ASPECT_DIFF) return false;
	let sum = 0;
	for (let i = 0; i < a.fp.length; i++) sum += Math.abs(a.fp[i] - b.fp[i]);
	return sum / a.fp.length <= MAX_MEAN_ABS_DIFF;
}

async function load(url: string): Promise<ImageInfo | null> {
	const res = await window.fetch(getProxiedImageUrl(url, 'emoji', true, true));
	if (!res.ok) return null;
	const blob = await res.blob();
	const animated = sniffAnimated(new Uint8Array(await blob.arrayBuffer()));
	if (animated == null) return null;
	const bitmap = await window.createImageBitmap(blob);
	try {
		const canvas = new OffscreenCanvas(SIZE, SIZE);
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (ctx == null) return null;
		ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);
		const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
		// premultiply so the colour of fully transparent pixels does not count
		const fp = new Float32Array(SIZE * SIZE * 4);
		for (let i = 0; i < SIZE * SIZE; i++) {
			const alpha = data[i * 4 + 3] / 255;
			fp[i * 4] = data[i * 4] * alpha;
			fp[i * 4 + 1] = data[i * 4 + 1] * alpha;
			fp[i * 4 + 2] = data[i * 4 + 2] * alpha;
			fp[i * 4 + 3] = data[i * 4 + 3];
		}
		return { fp, width: bitmap.width, height: bitmap.height, animated };
	} finally {
		bitmap.close();
	}
}

/**
 * Reads the animation flag from the container. The proxy emits WebP for everything it can
 * convert and passes APNG through untouched, so only those two containers are understood.
 * Returns null for anything else so the caller fails closed.
 */
function sniffAnimated(bytes: Uint8Array): boolean | null {
	const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
	if (bytes.length >= 16 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
		let p = 12;
		while (p + 8 <= bytes.length) {
			const size = bytes[p + 4] | (bytes[p + 5] << 8) | (bytes[p + 6] << 16) | (bytes[p + 7] << 24);
			if (ascii(p, 4) === 'VP8X') return (bytes[p + 8] & 0x02) !== 0;
			p += 8 + size + (size & 1);
		}
		return false; // simple (VP8/VP8L only) file: never animated
	}
	if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') {
		let p = 8;
		while (p + 8 <= bytes.length) {
			const size = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
			const tag = ascii(p + 4, 4);
			if (tag === 'acTL') return true;
			if (tag === 'IDAT') return false;
			p += 12 + size;
		}
		return false;
	}
	return null;
}
