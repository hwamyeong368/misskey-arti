/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ChatRoomInvitationPublished1794354011690 {
	name = 'ChatRoomInvitationPublished1794354011690'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room_invitation" ADD "invitePublishedAt" TIMESTAMP WITH TIME ZONE`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "chat_room_invitation" DROP COLUMN "invitePublishedAt"`);
	}
}
