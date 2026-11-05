/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// arti: custom emoji names used in a chat message, so they federate (column from CherryPick's AddChatMessageEmojis1762351977309)
export class ArtiChatMessageEmojis1793886763228 {
    name = 'ArtiChatMessageEmojis1793886763228';

    /**
     * @param {QueryRunner} queryRunner
     */
    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "chat_message" ADD COLUMN IF NOT EXISTS "emojis" character varying(128) array NOT NULL DEFAULT '{}'`);
    }

    /**
     * @param {QueryRunner} queryRunner
     */
    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "chat_message" DROP COLUMN "emojis"`);
    }
}
