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
import type { DriveFilesRepository, KyunetTranslationsRepository, NotesRepository, PollsRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { MiNote } from '@/models/Note.js';
import { buildNoteTranslationSource } from '@/misc/kyunet-note-source.js';
import type { MiKyunetTranslation } from '@/models/KyunetTranslation.js';
import { kyunetTranslationProviders } from '@/models/KyunetTranslationSetting.js';
import type { MiKyunetTranslationSetting, KyunetTranslationProvider } from '@/models/KyunetTranslationSetting.js';
import type { MiLocalUser } from '@/models/User.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { LoggerService } from '@/core/LoggerService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { IdService } from '@/core/IdService.js';
import { KyunetTranslationSettingService } from '@/core/KyunetTranslationSettingService.js';
import { KyunetTranslationLlmClient, KyunetLlmError } from '@/core/KyunetTranslationLlmClient.js';
import { KyunetTranslationDeeplClient } from '@/core/KyunetTranslationDeeplClient.js';
import type { KyunetLlmErrorReason, LlmInputItem, LlmOutputItem, TranslationKind } from '@/core/KyunetTranslationLlmClient.js';
import { splitForTranslation } from '@/misc/kyunet-translation-split.js';
import type { TextPiece } from '@/misc/kyunet-translation-split.js';
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
// arti: a piece of a work unit (the whole text, or one piece of a long text)
type Part = { unitHash: string; k: number; kind: TranslationKind; text: string };
type PartOut = { out: LlmOutputItem; provider: KyunetTranslationProvider } | null;

// arti: texts longer than this are sent to the LLM in pieces (paragraph / line / sentence boundaries)
const LONG_TEXT_PIECE_CHARS = 1000;
// arti: reply-shape errors where retrying the items one by one usually works
const RETRY_ONE_BY_ONE_REASONS = new Set<KyunetLlmErrorReason>(['count_mismatch', 'invalid_item', 'invalid_json', 'length', 'no_choice']);

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

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		private settingService: KyunetTranslationSettingService,
		private llmClient: KyunetTranslationLlmClient,
		private deeplClient: KyunetTranslationDeeplClient,
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
	public hashFor(kind: TranslationKind, text: string, provider: KyunetTranslationProvider = 'openai'): string {
		// arti: non-default providers get their own cache namespace so switching providers never serves the other one's results
		const prefix = provider === 'openai' ? '' : `${provider}\n`;
		return createHash('sha256').update(`${prefix}${kind}\n${this.normalizeText(text)}`).digest('hex');
	}

	// arti: call one translation backend
	private complete(setting: MiKyunetTranslationSetting, provider: KyunetTranslationProvider, targetLang: string, items: LlmInputItem[]) {
		return provider === 'deepl'
			? this.deeplClient.complete(setting, targetLang, items)
			: this.llmClient.complete(setting, targetLang, items);
	}

	/** arti: CW + body + poll choices + image descriptions (see kyunet-note-source.ts) */
	private async noteSource(note: MiNote): Promise<string> {
		const [poll, files] = await Promise.all([
			note.hasPoll ? this.pollsRepository.findOneBy({ noteId: note.id }) : Promise.resolve(null),
			note.fileIds.length > 0 ? this.driveFilesRepository.findBy({ id: In(note.fileIds) }) : Promise.resolve([]),
		]);
		const comments = note.fileIds.map(id => files.find(f => f.id === id)?.comment ?? null);
		return buildNoteTranslationSource(note, poll?.choices ?? [], comments);
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
				return { kind: 'note', text: await this.noteSource(note) };
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
			pending.push({ index, kind: r.kind, text: r.text, hash: this.hashFor(r.kind, r.text, setting.provider) });
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

		// 5. split long texts (arti), batch, 6-9. run
		const plans = [...work.values()].map(unit => ({ unit, pieces: this.piecesFor(unit, setting) }));
		const parts: Part[] = plans.flatMap(({ unit, pieces }) => pieces.map((piece, k) => ({ unitHash: unit.hash, k, kind: unit.kind, text: piece.text })));
		const outputs = new Map<Part, PartOut>();
		const batches = this.chunk(parts, setting);
		await Promise.all(batches.map(async batch => {
			const outs = await this.runBatch(batch, setting, targetLang);
			batch.forEach((part, j) => outputs.set(part, outs[j]));
		}));

		// 7-9. glue the pieces back, fill results, store
		const rows: MiKyunetTranslation[] = [];
		for (const { unit, pieces } of plans) {
			const partOuts = parts.filter(part => part.unitHash === unit.hash).map(part => outputs.get(part) ?? null);
			if (partOuts.some(o => o == null)) {
				for (const idx of unit.indices) results[idx] = FAILED;
				continue;
			}
			const done = partOuts as NonNullable<PartOut>[];
			const merged = this.mergePieces(pieces, done);
			const translated = this.postProcess(merged, unit.text);
			const providers = new Set(done.map(o => o.provider));
			const model = [...providers].map(p => p === 'deepl' ? 'deepl' : (setting.model ?? '')).join('+');
			const provider = providers.size > 1 ? 'mixed' : (providers.has('deepl') ? 'deepl' : 'llm');
			rows.push({ contentHash: unit.hash, targetLang: langKey, text: translated, sourceLangs: merged.sourceLangs, provider, model, createdAt: new Date() });
			for (const idx of unit.indices) results[idx] = { status: 'ok', text: translated, sourceLangs: merged.sourceLangs };
		}

		// a failed cache write only loses the cache entry; the translations are already in `results`
		try {
			await this.upsert(rows, force);
		} catch (err) {
			this.logger.warn(`storing translations failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		return results;
	}

	/** arti: long texts are translated in pieces by the LLM provider so one item cannot blow the token budget. */
	private piecesFor(unit: WorkUnit, setting: MiKyunetTranslationSetting): TextPiece[] {
		if (setting.provider !== 'openai' || unit.text.length <= LONG_TEXT_PIECE_CHARS) return [{ text: unit.text, sep: '' }];
		return splitForTranslation(unit.text, LONG_TEXT_PIECE_CHARS);
	}

	/** arti: pieces that need no translation keep their original text. */
	private mergePieces(pieces: TextPiece[], outs: NonNullable<PartOut>[]): LlmOutputItem {
		const sourceLangs = [...new Set(outs.flatMap(o => o.out.sourceLangs))];
		const translatedAny = outs.some(o => o.out.text !== '');
		if (!translatedAny) return { i: 0, sourceLangs, text: '' };
		const text = pieces.map((piece, k) => {
			const out = outs[k].out;
			return (out.text !== '' ? out.text : piece.text) + piece.sep;
		}).join('');
		return { i: 0, sourceLangs, text };
	}

	private chunk<T extends { text: string }>(units: T[], setting: MiKyunetTranslationSetting): T[][] {
		const batches: T[][] = [];
		let current: T[] = [];
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

	/** Runs one batch behind the semaphore. Returns one output per part, null where it could not be translated. */
	private async runBatch(batch: Part[], setting: MiKyunetTranslationSetting, targetLang: string): Promise<PartOut[]> {
		let acquired = false;
		try {
			acquired = await this.acquire(setting);
			if (!acquired) {
				this.logger.warn('semaphore wait exceeded; batch failed without an LLM call');
				return batch.map(() => null);
			}
			this.incrStat('llmItems', batch.length);
			this.incrStat('llmCalls');
			const input: LlmInputItem[] = batch.map((part, i) => ({ i, kind: part.kind, text: part.text }));
			return await this.completeWithRecovery(setting, targetLang, input);
		} catch (err) {
			// Redis error while taking the semaphore: only this batch fails
			this.logger.warn(`semaphore acquire failed; batch failed without an LLM call: ${err instanceof Error ? err.message : String(err)}`);
			return batch.map(() => null);
		} finally {
			if (acquired) {
				try {
					await this.release();
				} catch (err) {
					this.logger.warn(`semaphore release failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}
	}

	/**
	 * arti: when a batched call fails because the reply did not match the request (count / JSON / length errors),
	 * the items are retried one by one; whatever still failed is retried with the fallback provider when enabled.
	 */
	private async completeWithRecovery(setting: MiKyunetTranslationSetting, targetLang: string, input: LlmInputItem[]): Promise<PartOut[]> {
		const primary = setting.provider;
		const done = new Map<number, NonNullable<PartOut>>();
		const describe = (err: unknown) => err instanceof KyunetLlmError ? `${err.reason}: ${err.message}` : (err instanceof Error ? err.message : String(err));
		try {
			const { items } = await this.complete(setting, primary, targetLang, input);
			for (const out of items) done.set(out.i, { out, provider: primary });
		} catch (err) {
			this.incrStat('llmFailures');
			this.logger.warn(`${primary} batch of ${input.length} failed (${describe(err)})`);
			if (input.length > 1 && err instanceof KyunetLlmError && RETRY_ONE_BY_ONE_REASONS.has(err.reason)) {
				for (const item of input) {
					try {
						const { items } = await this.complete(setting, primary, targetLang, [item]);
						done.set(item.i, { out: items[0], provider: primary });
					} catch (err2) {
						this.logger.warn(`${primary} single item retry failed (${describe(err2)})`);
					}
				}
			}
			const fallback = this.settingService.fallbackProvider(setting);
			const missing = input.filter(item => !done.has(item.i));
			if (fallback != null && missing.length > 0) {
				try {
					const { items } = await this.complete(setting, fallback, targetLang, missing);
					for (const out of items) done.set(out.i, { out, provider: fallback });
					this.logger.info(`${missing.length} item(s) translated by fallback provider ${fallback}`);
				} catch (err3) {
					this.logger.warn(`fallback ${fallback} failed (${describe(err3)})`);
				}
			}
		}
		return input.map(item => done.get(item.i) ?? null);
	}

	/**
	 * spec 5.2 step 8 + 5.3: empty text or text identical to the source means "nothing to translate".
	 * The text alone decides. The schema used to carry a needsTranslation flag; the model regularly contradicted
	 * it (a correct translation flagged false, or the untouched source flagged true), so it was dropped.
	 */
	private postProcess(out: LlmOutputItem, source: string): string | null {
		const text = this.normalizeText(out.text);
		if (text === '') return null;
		if (text === source) return null;
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
	public async testTranslate(text: string, targetLang: string): Promise<{ ok: boolean; latencyMs: number; result?: { text: string | null; sourceLangs: string[] }; error?: string; raw?: unknown }> {
		const setting = this.settingService.get();
		const started = Date.now();
		try {
			const source = this.normalizeText(text);
			const { items, raw, latencyMs } = await this.complete(setting, setting.provider, targetLang, [{ i: 0, kind: 'note', text: source }]);
			// same verdict the real path stores: text null = nothing to translate
			return { ok: true, latencyMs, result: { text: this.postProcess(items[0], source), sourceLangs: items[0].sourceLangs }, raw };
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
		const text = await this.noteSource(note);
		const res = await this.translationsRepository.delete({ contentHash: In(kyunetTranslationProviders.map(provider => this.hashFor('note', text, provider))) });
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
