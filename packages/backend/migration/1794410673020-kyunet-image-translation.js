/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: feat/llm-translation - feat/image-translation

export class KyunetImageTranslation1794410673020 {
    name = 'KyunetImageTranslation1794410673020'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageEnabled" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageSystemPrompt" text`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageSeparateConnection" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageBaseUrl" character varying(1024)`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageApiKey" character varying(1024)`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageModel" character varying(256)`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageExtraParams" jsonb NOT NULL DEFAULT '{}'`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageStructuredOutput" boolean NOT NULL DEFAULT true`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageTimeoutMs" integer NOT NULL DEFAULT '50000'`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageMaxConcurrency" integer NOT NULL DEFAULT '4'`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "imageMaxTokensParam" character varying(32) NOT NULL DEFAULT 'max_completion_tokens'`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageMaxTokensParam"`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageMaxConcurrency"`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageTimeoutMs"`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageStructuredOutput"`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageExtraParams"`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageModel"`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageApiKey"`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageBaseUrl"`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageSeparateConnection"`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageSystemPrompt"`);
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "imageEnabled"`);
    }
}
