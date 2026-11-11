/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// arti: translation provider switch (openai-compatible LLM / DeepL) for the kyunet translation settings

export class KyunetTranslationProvider1794364950044 {
    name = 'KyunetTranslationProvider1794364950044'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "provider" character varying(16) NOT NULL DEFAULT 'openai'`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "provider"`);
    }
}
