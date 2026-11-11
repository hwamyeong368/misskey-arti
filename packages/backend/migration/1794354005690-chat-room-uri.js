/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomUri1794354005690 {
	name = 'ChatRoomUri1794354005690'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room" ADD "uri" character varying(512)`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "uri"`);
	}
}
