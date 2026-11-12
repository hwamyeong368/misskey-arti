/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: Fork-only single-row table holding the LLM translation settings (admin-editable at runtime).

import { Entity, Column, PrimaryColumn } from 'typeorm';

export type KyunetMaxTokensParam = 'max_completion_tokens' | 'max_tokens';

// arti: translation backend. 'openai' = OpenAI-compatible LLM (kyunet original), 'deepl' = DeepL API using meta.deeplAuthKey.
export const kyunetTranslationProviders = ['openai', 'deepl'] as const;
export type KyunetTranslationProvider = typeof kyunetTranslationProviders[number];

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

	// arti: which backend translates (see KyunetTranslationProvider)
	@Column('varchar', {
		length: 16, default: 'openai',
	})
	public provider: KyunetTranslationProvider;

	// arti: when the chosen provider fails, retry the failed items with the other provider (if it is configured)
	@Column('boolean', {
		default: false,
	})
	public fallbackEnabled: boolean;

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

	// kyunet: feat/llm-translation - feat/image-translation
	// Image translation. The prompt is always image-only; the connection fields apply only with imageSeparateConnection.
	@Column('boolean', {
		default: false,
	})
	public imageEnabled: boolean;

	@Column('text', {
		nullable: true,
	})
	public imageSystemPrompt: string | null;

	@Column('boolean', {
		default: false,
	})
	public imageSeparateConnection: boolean;

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public imageBaseUrl: string | null;

	@Column('varchar', {
		length: 1024, nullable: true,
	})
	public imageApiKey: string | null;

	@Column('varchar', {
		length: 256, nullable: true,
	})
	public imageModel: string | null;

	@Column('jsonb', {
		default: {},
	})
	public imageExtraParams: Record<string, unknown>;

	@Column('boolean', {
		default: true,
	})
	public imageStructuredOutput: boolean;

	@Column('integer', {
		default: 50000,
	})
	public imageTimeoutMs: number;

	@Column('integer', {
		default: 4,
	})
	public imageMaxConcurrency: number;

	@Column('varchar', {
		length: 32, default: 'max_completion_tokens',
	})
	public imageMaxTokensParam: KyunetMaxTokensParam;

	@Column('timestamp with time zone', {
		default: () => 'now()',
	})
	public updatedAt: Date;
}
