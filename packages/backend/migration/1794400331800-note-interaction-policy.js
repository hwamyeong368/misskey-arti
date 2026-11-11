/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// arti: per-note reply / quote policy, and quote authorizations granted to remote quotes (FEP-044f)
export class NoteInteractionPolicy1794400331800 {
	name = 'NoteInteractionPolicy1794400331800';

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note" ADD "replyPolicy" character varying(16)`);
		await queryRunner.query(`ALTER TABLE "note" ADD "quotePolicy" character varying(16)`);
		await queryRunner.query(`ALTER TABLE "note_draft" ADD "replyPolicy" character varying(16)`);
		await queryRunner.query(`ALTER TABLE "note_draft" ADD "quotePolicy" character varying(16)`);
		await queryRunner.query(`CREATE TABLE "note_quote_authorization" ("id" character varying(32) NOT NULL, "noteId" character varying(32) NOT NULL, "userId" character varying(32) NOT NULL, "interactingObject" character varying(512) NOT NULL, CONSTRAINT "PK_2da29da70ef5ebf7691934a4294" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_note_quote_authorization_note_object" ON "note_quote_authorization" ("noteId", "interactingObject") `);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "public"."IDX_note_quote_authorization_note_object"`);
		await queryRunner.query(`DROP TABLE "note_quote_authorization"`);
		await queryRunner.query(`ALTER TABLE "note_draft" DROP COLUMN "quotePolicy"`);
		await queryRunner.query(`ALTER TABLE "note_draft" DROP COLUMN "replyPolicy"`);
		await queryRunner.query(`ALTER TABLE "note" DROP COLUMN "quotePolicy"`);
		await queryRunner.query(`ALTER TABLE "note" DROP COLUMN "replyPolicy"`);
	}
}
