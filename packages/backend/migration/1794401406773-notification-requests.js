/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// arti: separate box for notifications from strangers
export class NotificationRequests1794401406773 {
	name = 'NotificationRequests1794401406773';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" ADD "notificationRequestsEnabled" boolean NOT NULL DEFAULT false`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "notificationRequestsEnabled"`);
	}
}
