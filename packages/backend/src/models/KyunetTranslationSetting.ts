/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only single-row table holding the LLM translation settings (admin-editable at runtime).

import { Entity, Column, PrimaryColumn } from 'typeorm';

export type KyunetMaxTokensParam = 'max_completion_tokens' | 'max_tokens';

@Entity('kyunet_translation_setting')
export class MiKyunetTranslationSetting {
	@PrimaryColumn({
		type: 'varchar',
		length: 32,
	})
	public id: string;

	@Column('boolean', {
		default: false,
	})
	public enabled: boolean;

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public baseUrl: string | null;

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public apiKey: string | null;

	@Column('varchar', {
		length: 256, nullable: true,
	})
	public model: string | null;

	@Column('jsonb', {
		default: {},
	})
	public extraParams: Record<string, unknown>;

	@Column('text', {
		nullable: true,
	})
	public systemPrompt: string | null;

	@Column('boolean', {
		default: true,
	})
	public structuredOutput: boolean;

	@Column('integer', {
		default: 60000,
	})
	public timeoutMs: number;

	@Column('integer', {
		default: 16,
	})
	public maxConcurrency: number;

	@Column('varchar', {
		length: 32, default: 'max_completion_tokens',
	})
	public maxTokensParam: KyunetMaxTokensParam;

	@Column('integer', {
		default: 3000,
	})
	public maxInputLength: number;

	@Column('integer', {
		default: 4000,
	})
	public batchMaxChars: number;

	@Column('integer', {
		default: 8,
	})
	public batchMaxItems: number;

	@Column('boolean', {
		default: true,
	})
	public heuristicGate: boolean;

	@Column('integer', {
		default: 0,
	})
	public cacheRetentionDays: number;

	@Column('timestamp with time zone', {
		default: () => 'now()',
	})
	public updatedAt: Date;
}
