/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// arti: FEP-044f quote requests (Mastodon 4.5+). A remote server asks before it shows a quote of a local note;
// we answer with Accept + a QuoteAuthorization (or Reject) according to the note's quote policy.

import { Inject, Injectable } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { NotesRepository, NoteQuoteAuthorizationsRepository } from '@/models/_.js';
import type { MiRemoteUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { MiNoteQuoteAuthorization } from '@/models/NoteQuoteAuthorization.js';
import { IdService } from '@/core/IdService.js';
import { QueueService } from '@/core/QueueService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { NoteInteractionPolicyService } from '@/core/NoteInteractionPolicyService.js';
import { UserBlockingService } from '@/core/UserBlockingService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { getApId } from '@/core/activitypub/type.js';
import type { IQuoteRequest } from '@/core/activitypub/type.js';
import { bindThis } from '@/decorators.js';
import { isDuplicateKeyValueError } from '@/misc/is-duplicate-key-value-error.js';

const MAX_URI_LENGTH = 512;

@Injectable()
export class ApQuoteRequestService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.noteQuoteAuthorizationsRepository)
		private noteQuoteAuthorizationsRepository: NoteQuoteAuthorizationsRepository,

		private idService: IdService,
		private queueService: QueueService,
		private userEntityService: UserEntityService,
		private noteInteractionPolicyService: NoteInteractionPolicyService,
		private userBlockingService: UserBlockingService,
		private apRendererService: ApRendererService,
	) {
	}

	@bindThis
	public authorizationUri(id: MiNoteQuoteAuthorization['id']): string {
		return `${this.config.url}/quote_authorizations/${id}`;
	}

	@bindThis
	public async handle(actor: MiRemoteUser, activity: IQuoteRequest): Promise<string> {
		const notePrefix = `${this.config.url}/notes/`;
		const targetUri = getApId(activity.object);
		if (!targetUri.startsWith(notePrefix)) return 'skip: quote request for a note that is not ours';
		const noteId = targetUri.slice(notePrefix.length);

		const note = await this.notesRepository.findOneBy({ id: noteId, userHost: IsNull() });
		if (note == null) return 'skip: quoted note not found';

		if (activity.instrument == null) return 'skip: quote request without instrument';
		const instrumentUri = getApId(activity.instrument);
		if (instrumentUri.length > MAX_URI_LENGTH) return 'skip: instrument uri too long';
		// the quoting post must belong to the requesting server
		if (new URL(instrumentUri).host !== new URL(getApId(activity.actor)).host) return 'skip: instrument is not on the actor\'s server';

		const request = {
			id: activity.id,
			type: 'QuoteRequest',
			actor: getApId(activity.actor),
			object: targetUri,
			instrument: instrumentUri,
		};

		const quotable = (note.visibility === 'public' || note.visibility === 'home') && !note.localOnly
			&& !(await this.userBlockingService.checkBlocked(note.userId, actor.id));
		if (!quotable || !(await this.noteInteractionPolicyService.isAllowed(note, 'quote', actor.id))) {
			const reject = this.apRendererService.addContext(this.apRendererService.renderReject(request as never, { id: note.userId }));
			this.queueService.deliver({ id: note.userId }, reject, actor.inbox, false);
			return 'ok: quote rejected';
		}

		const authorization = await this.findOrCreate(note, actor, instrumentUri);
		const accept = this.apRendererService.addContext({
			...this.apRendererService.renderAccept(request as never, { id: note.userId, host: null }),
			result: this.authorizationUri(authorization.id),
		});
		this.queueService.deliver({ id: note.userId }, accept, actor.inbox, false);
		return 'ok: quote accepted';
	}

	/** QuoteAuthorization object for GET /quote_authorizations/:id, or null when it no longer applies. */
	@bindThis
	public async renderAuthorization(id: string): Promise<Record<string, unknown> | null> {
		const authorization = await this.noteQuoteAuthorizationsRepository.findOneBy({ id });
		if (authorization == null) return null;
		const note = await this.notesRepository.findOneBy({ id: authorization.noteId, userHost: IsNull() });
		if (note == null) return null;
		return this.apRendererService.addContext({
			id: this.authorizationUri(authorization.id),
			type: 'QuoteAuthorization',
			attributedTo: this.userEntityService.genLocalUserUri(note.userId),
			interactingObject: authorization.interactingObject,
			interactionTarget: `${this.config.url}/notes/${note.id}`,
		});
	}

	private async findOrCreate(note: MiNote, actor: MiRemoteUser, interactingObject: string): Promise<MiNoteQuoteAuthorization> {
		const existing = await this.noteQuoteAuthorizationsRepository.findOneBy({ noteId: note.id, interactingObject });
		if (existing != null) return existing;
		try {
			return await this.noteQuoteAuthorizationsRepository.insertOne({
				id: this.idService.gen(),
				noteId: note.id,
				userId: actor.id,
				interactingObject,
			});
		} catch (err) {
			if (isDuplicateKeyValueError(err)) {
				return await this.noteQuoteAuthorizationsRepository.findOneByOrFail({ noteId: note.id, interactingObject });
			}
			throw err;
		}
	}
}
