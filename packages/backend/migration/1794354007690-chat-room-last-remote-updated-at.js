/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomLastRemoteUpdatedAt1794354007690 {
	name = 'ChatRoomLastRemoteUpdatedAt1794354007690'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room" ADD "lastRemoteUpdatedAt" TIMESTAMP WITH TIME ZONE`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room" DROP COLUMN "lastRemoteUpdatedAt"`);
	}
}
