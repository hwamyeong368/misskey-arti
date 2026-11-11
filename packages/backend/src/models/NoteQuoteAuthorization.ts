/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Entity, Index, Column, PrimaryColumn } from 'typeorm';
import { id } from './util/id.js';
import type { MiNote } from './Note.js';
import type { MiUser } from './User.js';

/**
 * arti: a quote of a local note by a remote post, approved through a FEP-044f QuoteRequest (Mastodon 4.5+).
 * Served as a QuoteAuthorization object at /quote_authorizations/:id.
 */
@Entity('note_quote_authorization')
@Index('IDX_note_quote_authorization_note_object', ['noteId', 'interactingObject'], { unique: true })
export class MiNoteQuoteAuthorization {
	@PrimaryColumn(id())
	public id: string;

	/** The quoted (local) note. */
	@Column(id())
	public noteId: MiNote['id'];

	/** The remote user who quoted it. */
	@Column(id())
	public userId: MiUser['id'];

	/** URI of the quoting post. */
	@Column('varchar', { length: 512 })
	public interactingObject: string;
}
