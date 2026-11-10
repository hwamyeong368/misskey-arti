/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only translation cache keyed by content hash + target language (no FK to notes / users).

import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

@Entity('kyunet_translation')
@Index('IDX_kyunet_translation_createdAt', ['createdAt'])
export class MiKyunetTranslation {
	@PrimaryColumn('varchar', {
		length: 64,
		comment: 'sha256 hex of `${kind}\\n${normalizedText}`',
	})
	public contentHash: string;

	@PrimaryColumn('varchar', {
		length: 32,
		comment: 'lower-cased BCP 47 tag',
	})
	public targetLang: string;

	@Column('text', {
		nullable: true,
		comment: 'null means "nothing to translate"',
	})
	public text: string | null;

	@Column('jsonb', {
		default: [],
	})
	public sourceLangs: string[];

	@Column('varchar', {
		length: 32,
	})
	public provider: string;

	@Column('varchar', {
		length: 256,
	})
	public model: string;

	@Column('timestamp with time zone')
	public createdAt: Date;
}
