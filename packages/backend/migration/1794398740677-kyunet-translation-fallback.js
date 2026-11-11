/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// arti: retry failed translations with the other provider

export class KyunetTranslationFallback1794398740677 {
    name = 'KyunetTranslationFallback1794398740677'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" ADD "fallbackEnabled" boolean NOT NULL DEFAULT false`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "kyunet_translation_setting" DROP COLUMN "fallbackEnabled"`);
    }
}
