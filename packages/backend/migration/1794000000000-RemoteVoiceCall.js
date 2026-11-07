/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RemoteVoiceCall1794000000000 {
	name = 'RemoteVoiceCall1794000000000'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" ADD "enableRemoteVoiceCall" boolean NOT NULL DEFAULT false`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "enableRemoteVoiceCall"`);
	}
}
