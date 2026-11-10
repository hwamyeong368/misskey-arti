/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only request queue for LLM translation (spec 7.1). Pure: the transport is injected so
// the queue can be unit-tested with fake timers. One global instance lives in use-kyunet-translation.ts.

import { ref } from 'vue';
import type { Ref } from 'vue';
import type * as Misskey from 'misskey-js';

export type KyunetTranslationRef = Misskey.Endpoints['kyunet/translate']['req']['items'][number];
export type KyunetTranslationResult = Misskey.Endpoints['kyunet/translate']['res']['items'][number];

export type KyunetTranslationSend = (items: KyunetTranslationRef[], targetLang: string, force?: boolean) => Promise<KyunetTranslationResult[]>;

export type KyunetTranslationQueueOptions = {
	debounceMs: number;
	maxItems: number;
	/** How long a failed result is kept before a new request() retries it. */
	failedTtlMs: number;
	/** Shorter retry TTL used when the server answered with a rate-limit error. */
	rateLimitedTtlMs: number;
	/** At most one flush (batch send) starts per this interval, so the client cannot exhaust its own rate limit. */
	minIntervalMs: number;
};

const DEFAULT_OPTIONS: KyunetTranslationQueueOptions = {
	debounceMs: 200,
	maxItems: 50,
	failedTtlMs: 60 * 1000,
	rateLimitedTtlMs: 15 * 1000,
	minIntervalMs: 1000,
};
const FAILED: KyunetTranslationResult = { status: 'failed', text: null, sourceLangs: [] };

type Entry = {
	ref: KyunetTranslationRef;
	targetLang: string;
	result: Ref<KyunetTranslationResult | null>;
	/** When a failed entry may be re-requested; null = not failed. */
	retryAt: number | null;
	inFlight: boolean;
};

export function kyunetTranslationKey(ref: KyunetTranslationRef, targetLang: string): string {
	const index = 'index' in ref && ref.index != null ? String(ref.index) : '';
	return `${ref.type}:${ref.id}:${index}:${targetLang}`;
}

/** misskeyApi rejects with the API error body (`{ code, ... }`); a raw 429 from a proxy may surface as a status. */
function isRateLimitError(err: unknown): boolean {
	if (typeof err !== 'object' || err == null) return false;
	const e = err as { code?: unknown; httpStatusCode?: unknown; status?: unknown };
	return e.code === 'RATE_LIMIT_EXCEEDED' || e.httpStatusCode === 429 || e.status === 429;
}

export class KyunetTranslationQueue {
	private entries = new Map<string, Entry>();
	private pending = new Map<string, Entry[]>(); // targetLang -> entries waiting to be sent
	private inFlightLangs = new Set<string>(); // targetLang with a batch currently being sent
	private timer: number | null = null;
	private timerAt = 0;
	private lastFlushAt = Number.NEGATIVE_INFINITY;
	private opts: KyunetTranslationQueueOptions;

	constructor(private send: KyunetTranslationSend, opts: Partial<KyunetTranslationQueueOptions> = {}) {
		this.opts = { ...DEFAULT_OPTIONS, ...opts };
	}

	/** Returns a reactive ref that is filled when the batch completes. Cached results return immediately. */
	public request(ref: KyunetTranslationRef, targetLang: string): Ref<KyunetTranslationResult | null> {
		const key = kyunetTranslationKey(ref, targetLang);
		let entry = this.entries.get(key);
		if (entry == null) {
			entry = { ref, targetLang, result: ref_(null), retryAt: null, inFlight: false };
			this.entries.set(key, entry);
			this.enqueue(entry);
			return entry.result;
		}
		if (entry.retryAt != null && Date.now() >= entry.retryAt && !entry.inFlight) {
			entry.retryAt = null;
			this.enqueue(entry);
		}
		return entry.result;
	}

	/** The cached result for a key, without enqueueing anything (spec 7.3: re-showing needs no server request). */
	public peek(ref: KyunetTranslationRef, targetLang: string): KyunetTranslationResult | null {
		return this.entries.get(kyunetTranslationKey(ref, targetLang))?.result.value ?? null;
	}

	/** Manual translation: no debounce, `force: true`, result also written into the shared cache entry. */
	public async translateNow(ref: KyunetTranslationRef, targetLang: string): Promise<KyunetTranslationResult> {
		const key = kyunetTranslationKey(ref, targetLang);
		let entry = this.entries.get(key);
		if (entry == null) {
			entry = { ref, targetLang, result: ref_(null), retryAt: null, inFlight: false };
			this.entries.set(key, entry);
		}
		let result: KyunetTranslationResult;
		let rateLimited = false;
		try {
			result = (await this.send([ref], targetLang, true))[0] ?? FAILED;
		} catch (err) {
			result = FAILED;
			rateLimited = isRateLimitError(err);
		}
		// a failed forced retry must not throw away a good cached translation; the caller still sees the failure
		if (!(result.status === 'failed' && entry.result.value?.status === 'ok')) {
			entry.result.value = result;
			entry.retryAt = this.retryAtFor(result, rateLimited);
		}
		return result;
	}

	/** Sends one slot now, ignoring the debounce timer (the in-flight rule still applies). */
	public async flush(): Promise<void> {
		this.clearTimer();
		await this.runSlot();
	}

	private enqueue(entry: Entry): void {
		entry.inFlight = true;
		const list = this.pending.get(entry.targetLang) ?? [];
		list.push(entry);
		this.pending.set(entry.targetLang, list);
		// a full batch goes out at the next allowed slot instead of waiting for the debounce
		this.schedule(list.length >= this.opts.maxItems ? 0 : this.opts.debounceMs);
	}

	/** Arms the flush timer for `delayMs` from now, but never earlier than the min interval allows. */
	private schedule(delayMs: number): void {
		const now = Date.now();
		const at = Math.max(now + delayMs, this.lastFlushAt + this.opts.minIntervalMs);
		if (this.timer != null) {
			if (this.timerAt <= at) return;
			this.clearTimer();
		}
		this.timerAt = at;
		this.timer = window.setTimeout(() => {
			this.timer = null;
			void this.runSlot();
		}, at - now);
	}

	private clearTimer(): void {
		if (this.timer != null) {
			window.clearTimeout(this.timer);
			this.timer = null;
		}
	}

	private async runSlot(): Promise<void> {
		const sends: Promise<void>[] = [];
		for (const [targetLang, list] of [...this.pending.entries()]) {
			if (this.inFlightLangs.has(targetLang)) continue; // resent when the in-flight batch resolves
			const batch = list.splice(0, this.opts.maxItems);
			if (list.length === 0) this.pending.delete(targetLang);
			sends.push(this.sendBatch(targetLang, batch));
		}
		if (sends.length === 0) return;
		this.lastFlushAt = Date.now();
		await Promise.all(sends);
	}

	private async sendBatch(targetLang: string, entries: Entry[]): Promise<void> {
		this.inFlightLangs.add(targetLang);
		let results: KyunetTranslationResult[];
		let rateLimited = false;
		try {
			results = await this.send(entries.map(e => e.ref), targetLang);
			if (results.length !== entries.length) throw new Error('length mismatch');
		} catch (err) {
			results = entries.map(() => FAILED);
			rateLimited = isRateLimitError(err);
		}
		this.inFlightLangs.delete(targetLang);
		entries.forEach((entry, i) => {
			entry.inFlight = false;
			entry.result.value = results[i];
			entry.retryAt = this.retryAtFor(results[i], rateLimited);
		});
		if (this.pending.has(targetLang)) this.schedule(0);
	}

	private retryAtFor(result: KyunetTranslationResult, rateLimited: boolean): number | null {
		if (result.status !== 'failed') return null;
		return Date.now() + (rateLimited ? this.opts.rateLimitedTtlMs : this.opts.failedTtlMs);
	}
}

function ref_(v: KyunetTranslationResult | null): Ref<KyunetTranslationResult | null> {
	return ref(v);
}
