/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only LLM translation service (spec 5.2 / 5.4). Resolves references to source text,
// consults the script gate and the hash cache, batches cache misses into LLM calls behind a Redis
// semaphore, and stores results. Also owns cache cleanup and the admin test / stats helpers.

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { In, LessThan } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { KyunetTranslationsRepository, NotesRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { MiKyunetTranslation } from '@/models/KyunetTranslation.js';
import type { MiKyunetTranslationSetting } from '@/models/KyunetTranslationSetting.js';
import type { MiLocalUser } from '@/models/User.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { LoggerService } from '@/core/LoggerService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { IdService } from '@/core/IdService.js';
import { KyunetTranslationSettingService } from '@/core/KyunetTranslationSettingService.js';
import { KyunetTranslationLlmClient, KyunetLlmError } from '@/core/KyunetTranslationLlmClient.js';
import type { LlmInputItem, LlmOutputItem, TranslationKind } from '@/core/KyunetTranslationLlmClient.js';
import { isObviouslyTargetLang, primaryLang } from '@/misc/kyunet-script-gate.js';
import { shouldHideNoteByTime } from '@/misc/should-hide-note-by-time.js';

export type TranslationItemRef =
	| { type: 'note' | 'user_name' | 'user_description'; id: string }
	| { type: 'user_field_name' | 'user_field_value'; id: string; index: number };

export type TranslationResult = {
	status: 'ok' | 'unavailable' | 'failed';
	text: string | null;
	sourceLangs: string[];
};

export type TranslationStats = {
	cacheRows: number;
	gateSkipped: number;
	cacheHits: number;
	llmItems: number;
	llmCalls: number;
	llmFailures: number;
};

export type ClearCacheFilter =
	| { all: true }
	| { olderThanDays: number }
	| { model: string }
	| { noteId: string };

type Resolved = { ok: true; kind: TranslationKind; text: string } | { ok: false };
type WorkUnit = { hash: string; kind: TranslationKind; text: string; indices: number[] };

// shared by every result slot that has no translation, so they are frozen to keep one slot from leaking into another
function frozenEmptyResult(status: 'unavailable' | 'failed'): TranslationResult {
	return Object.freeze({ status, text: null, sourceLangs: Object.freeze([]) as unknown as string[] });
}

const UNAVAILABLE = frozenEmptyResult('unavailable');
const FAILED = frozenEmptyResult('failed');

const SEMAPHORE_POLL_MS = 250;
const SEMAPHORE_MAX_WAIT_MS = 10000;
const STAT_FIELDS = ['gateSkipped', 'cacheHits', 'llmItems', 'llmCalls', 'llmFailures'] as const;
type StatField = typeof STAT_FIELDS[number];

// global setTimeout on purpose: vitest fake timers patch it, but not node:timers/promises
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

@Injectable()
export class KyunetTranslationService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.kyunetTranslationsRepository)
		private translationsRepository: KyunetTranslationsRepository,

		private settingService: KyunetTranslationSettingService,
		private llmClient: KyunetTranslationLlmClient,
		private noteEntityService: NoteEntityService,
		private idService: IdService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('kyunet-translation');
	}

	private get semaphoreKey(): string {
		return `${this.config.redis.prefix}:kyunet:translation:sem`;
	}

	private get statsKey(): string {
		return `${this.config.redis.prefix}:kyunet:translation:stats`;
	}

	@bindThis
	public normalizeText(text: string): string {
		return text.replace(/\r\n/g, '\n').trim();
	}

	@bindThis
	public hashFor(kind: TranslationKind, text: string): string {
		return createHash('sha256').update(`${kind}\n${this.normalizeText(text)}`).digest('hex');
	}

	//#region resolvers
	private async resolve(ref: TranslationItemRef, me: MiLocalUser, setting: MiKyunetTranslationSetting): Promise<Resolved> {
		const raw = await this.resolveRaw(ref, me);
		if (raw == null) return { ok: false };
		const text = this.normalizeText(raw.text);
		if (text === '' || text.length > setting.maxInputLength) return { ok: false };
		return { ok: true, kind: raw.kind, text };
	}

	private async resolveRaw(ref: TranslationItemRef, me: MiLocalUser): Promise<{ kind: TranslationKind; text: string } | null> {
		switch (ref.type) {
			case 'note': {
				const note = await this.notesRepository.findOne({ where: { id: ref.id }, relations: { user: true } });
				if (note?.user == null) return null;
				if (!(await this.noteEntityService.isVisibleForMe(note, me.id))) return null;
				// Mirrors NoteEntityService.shouldHideNote for an authenticated requester (keep in sync with it).
				// A full pack() per item was too expensive; requireSigninToViewContents / ugcVisibilityForVisitor only
				// apply to anonymous requesters, and this endpoint requires credentials.
				if (me.id !== note.userId) {
					const createdAt = this.idService.parse(note.id).date; // same source as the packed note's createdAt
					if (shouldHideNoteByTime(note.user.makeNotesHiddenBefore, createdAt)) return null;
					if (
						(note.visibility === 'public' || note.visibility === 'home')
						&& shouldHideNoteByTime(note.user.makeNotesFollowersOnlyBefore, createdAt)
						&& !(await this.noteEntityService.isVisibleForMe({ ...note, visibility: 'followers' }, me.id))
					) return null;
				}
				let text = note.text ?? '';
				if (note.cw != null) text = `${note.cw}\n-----\n${text}`;
				return { kind: 'note', text };
			}
			case 'user_name': {
				const user = await this.usersRepository.findOneBy({ id: ref.id });
				if (user?.name == null) return null;
				return { kind: 'user_name', text: user.name };
			}
			case 'user_description': {
				const profile = await this.userProfilesRepository.findOneBy({ userId: ref.id });
				if (profile?.description == null) return null;
				return { kind: 'user_description', text: profile.description };
			}
			case 'user_field_name':
			case 'user_field_value': {
				if (!Number.isInteger(ref.index) || ref.index < 0) return null;
				const profile = await this.userProfilesRepository.findOneBy({ userId: ref.id });
				const field = profile?.fields[ref.index];
				if (field == null) return null;
				return { kind: ref.type, text: ref.type === 'user_field_name' ? field.name : field.value };
			}
			default:
				return null;
		}
	}
	//#endregion

	//#region semaphore / stats
	private async acquire(setting: MiKyunetTranslationSetting): Promise<boolean> {
		const deadline = Date.now() + Math.min(setting.timeoutMs, SEMAPHORE_MAX_WAIT_MS);
		for (;;) {
			const n = await this.redisClient.incr(this.semaphoreKey);
			if (n === 1) {
				// first holder sets the TTL; later holders do not refresh it so a leaked count eventually expires
				await this.redisClient.expire(this.semaphoreKey, Math.ceil((setting.timeoutMs * 2) / 1000));
			}
			if (n <= setting.maxConcurrency) return true;
			await this.redisClient.decr(this.semaphoreKey);
			if (Date.now() >= deadline) return false;
			await sleep(SEMAPHORE_POLL_MS);
		}
	}

	private async release(): Promise<void> {
		const n = await this.redisClient.decr(this.semaphoreKey);
		if (n < 0) {
			// the key expired while we were running: reset instead of leaving a negative floor
			await this.redisClient.del(this.semaphoreKey);
		}
	}

	private incrStat(field: StatField, by = 1): void {
		this.redisClient.hincrby(this.statsKey, field, by).catch(err => this.logger.warn(`stats update failed: ${err}`));
	}
	//#endregion

	@bindThis
	public async translate(items: TranslationItemRef[], targetLang: string, me: MiLocalUser, opts: { force?: boolean } = {}): Promise<TranslationResult[]> {
		const setting = this.settingService.get();
		const force = opts.force ?? false;
		const langKey = targetLang.toLowerCase();
		const results: TranslationResult[] = new Array(items.length).fill(UNAVAILABLE);

		// 1. resolve
		// one throwing resolver only makes its own item unavailable
		const resolved = await Promise.all(items.map(ref => this.resolve(ref, me, setting).catch((err): Resolved => {
			this.logger.warn(`resolving ${ref.type}:${ref.id} failed: ${err instanceof Error ? err.message : String(err)}`);
			return { ok: false };
		})));

		// 2. gate, 3. collect pending
		const pending: { index: number; kind: TranslationKind; text: string; hash: string }[] = [];
		let gateSkipped = 0;
		resolved.forEach((r, index) => {
			if (!r.ok) return;
			if (!force && setting.heuristicGate && r.kind !== 'user_name' && isObviouslyTargetLang(r.text, targetLang)) {
				results[index] = { status: 'ok', text: null, sourceLangs: [primaryLang(targetLang)] };
				gateSkipped++;
				return;
			}
			pending.push({ index, kind: r.kind, text: r.text, hash: this.hashFor(r.kind, r.text) });
		});
		if (gateSkipped > 0) this.incrStat('gateSkipped', gateSkipped);
		if (pending.length === 0) return results;

		// 4. cache lookup (skipped entirely on force: an explicit retry may mean "the cached translation is wrong")
		const hashes = [...new Set(pending.map(p => p.hash))];
		const cached = force ? [] : await this.translationsRepository.findBy({ contentHash: In(hashes), targetLang: langKey });
		const cacheMap = new Map(cached.map(row => [row.contentHash, row]));
		const work = new Map<string, WorkUnit>();
		let cacheHits = 0;
		for (const p of pending) {
			const hit = cacheMap.get(p.hash);
			if (hit != null) {
				results[p.index] = { status: 'ok', text: hit.text, sourceLangs: hit.sourceLangs };
				cacheHits++;
				continue;
			}
			const unit = work.get(p.hash);
			if (unit) unit.indices.push(p.index);
			else work.set(p.hash, { hash: p.hash, kind: p.kind, text: p.text, indices: [p.index] });
		}
		if (cacheHits > 0) this.incrStat('cacheHits', cacheHits);
		if (work.size === 0) return results;

		// 5. batch, 6-9. run
		const batches = this.chunk([...work.values()], setting);
		await Promise.all(batches.map(batch => this.runBatch(batch, setting, targetLang, langKey, force, results)));
		return results;
	}

	private chunk(units: WorkUnit[], setting: MiKyunetTranslationSetting): WorkUnit[][] {
		const batches: WorkUnit[][] = [];
		let current: WorkUnit[] = [];
		let chars = 0;
		for (const unit of units) {
			const over = current.length > 0 && (current.length >= setting.batchMaxItems || chars + unit.text.length > setting.batchMaxChars);
			if (over) {
				batches.push(current);
				current = [];
				chars = 0;
			}
			current.push(unit);
			chars += unit.text.length;
		}
		if (current.length > 0) batches.push(current);
		return batches;
	}

	private async runBatch(batch: WorkUnit[], setting: MiKyunetTranslationSetting, targetLang: string, langKey: string, force: boolean, results: TranslationResult[]): Promise<void> {
		const markFailed = () => { for (const unit of batch) for (const i of unit.indices) results[i] = FAILED; };
		let acquired = false;
		let rows: MiKyunetTranslation[] | null = null;
		try {
			acquired = await this.acquire(setting);
			if (!acquired) {
				this.logger.warn('semaphore wait exceeded; batch failed without an LLM call');
				markFailed();
				return;
			}
			this.incrStat('llmItems', batch.length);
			this.incrStat('llmCalls');
			const input: LlmInputItem[] = batch.map((unit, i) => ({ i, kind: unit.kind, text: unit.text }));
			const { items: output } = await this.llmClient.complete(setting, targetLang, input);
			const built: MiKyunetTranslation[] = [];
			output.forEach((out, i) => {
				const unit = batch[i];
				const translated = this.postProcess(out, unit.text);
				built.push({ contentHash: unit.hash, targetLang: langKey, text: translated, sourceLangs: out.sourceLangs, provider: 'llm', model: setting.model ?? '', createdAt: new Date() });
				for (const idx of unit.indices) results[idx] = { status: 'ok', text: translated, sourceLangs: out.sourceLangs };
			});
			rows = built;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (acquired) {
				this.incrStat('llmFailures');
				const reason = err instanceof KyunetLlmError ? err.reason : 'unknown';
				this.logger.warn(`LLM batch failed (${reason}): ${message}`);
			} else {
				// Redis error while taking the semaphore: only this batch fails
				this.logger.warn(`semaphore acquire failed; batch failed without an LLM call: ${message}`);
			}
			markFailed();
		} finally {
			if (acquired) {
				try {
					await this.release();
				} catch (err) {
					this.logger.warn(`semaphore release failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}

		if (rows == null) return;
		// a failed cache write only loses the cache entry; the translations are already in `results`
		try {
			await this.upsert(rows, force);
		} catch (err) {
			this.logger.warn(`storing translations failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/** spec 5.2 step 8 + 5.3: needsTranslation=false, empty text, or text identical to the source all mean "nothing to translate". */
	private postProcess(out: LlmOutputItem, source: string): string | null {
		if (!out.needsTranslation) return null;
		if (out.text === '') return null;
		if (this.normalizeText(out.text) === source) return null;
		return out.text;
	}

	private async upsert(rows: MiKyunetTranslation[], force: boolean): Promise<void> {
		if (rows.length === 0) return;
		const qb = this.translationsRepository.createQueryBuilder().insert().values(rows);
		if (force) {
			await qb.orUpdate(['text', 'sourceLangs', 'model', 'createdAt'], ['contentHash', 'targetLang']).execute();
		} else {
			await qb.orIgnore().execute();
		}
	}

	@bindThis
	public async testTranslate(text: string, targetLang: string): Promise<{ ok: boolean; latencyMs: number; result?: LlmOutputItem; error?: string; raw?: unknown }> {
		const setting = this.settingService.get();
		const started = Date.now();
		try {
			const { items, raw, latencyMs } = await this.llmClient.complete(setting, targetLang, [{ i: 0, kind: 'note', text: this.normalizeText(text) }]);
			return { ok: true, latencyMs, result: items[0], raw };
		} catch (err) {
			const reason = err instanceof KyunetLlmError ? `${err.reason}: ${err.message}` : (err instanceof Error ? err.message : String(err));
			return { ok: false, latencyMs: Date.now() - started, error: reason };
		}
	}

	@bindThis
	public async clearCache(filter: ClearCacheFilter): Promise<number> {
		if ('all' in filter) {
			const res = await this.translationsRepository.createQueryBuilder().delete().execute();
			return res.affected ?? 0;
		}
		if ('olderThanDays' in filter) {
			const res = await this.translationsRepository.delete({ createdAt: LessThan(new Date(Date.now() - filter.olderThanDays * 24 * 60 * 60 * 1000)) });
			return res.affected ?? 0;
		}
		if ('model' in filter) {
			const res = await this.translationsRepository.delete({ model: filter.model });
			return res.affected ?? 0;
		}
		const note = await this.notesRepository.findOneBy({ id: filter.noteId });
		if (note == null) throw new Error('no such note');
		let text = note.text ?? '';
		if (note.cw != null) text = `${note.cw}\n-----\n${text}`;
		const res = await this.translationsRepository.delete({ contentHash: this.hashFor('note', text) });
		return res.affected ?? 0;
	}

	/** Called from CleanProcessorService. */
	@bindThis
	public async cleanExpiredCache(): Promise<void> {
		const days = this.settingService.get().cacheRetentionDays;
		if (days <= 0) return;
		await this.translationsRepository.delete({ createdAt: LessThan(new Date(Date.now() - days * 24 * 60 * 60 * 1000)) });
	}

	@bindThis
	public async getStats(): Promise<TranslationStats> {
		const [raw, cacheRows] = await Promise.all([
			this.redisClient.hgetall(this.statsKey),
			this.translationsRepository.count(),
		]);
		const stats = { cacheRows } as TranslationStats;
		for (const field of STAT_FIELDS) stats[field] = Number(raw[field] ?? 0);
		return stats;
	}
}
