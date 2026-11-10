/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// kyunet: fork-only LLM translation tables (settings + cache)

export class KyunetTranslation1794326646958 {
    name = 'KyunetTranslation1794326646958'

    async up(queryRunner) {
        await queryRunner.query(`CREATE TABLE "kyunet_translation_setting" ("id" character varying(32) NOT NULL, "enabled" boolean NOT NULL DEFAULT false, "baseUrl" character varying(1024), "apiKey" character varying(1024), "model" character varying(256), "extraParams" jsonb NOT NULL DEFAULT '{}', "systemPrompt" text, "structuredOutput" boolean NOT NULL DEFAULT true, "timeoutMs" integer NOT NULL DEFAULT '60000', "maxConcurrency" integer NOT NULL DEFAULT '16', "maxTokensParam" character varying(32) NOT NULL DEFAULT 'max_completion_tokens', "maxInputLength" integer NOT NULL DEFAULT '3000', "batchMaxChars" integer NOT NULL DEFAULT '4000', "batchMaxItems" integer NOT NULL DEFAULT '8', "heuristicGate" boolean NOT NULL DEFAULT true, "cacheRetentionDays" integer NOT NULL DEFAULT '0', "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_kyunet_translation_setting" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "kyunet_translation" ("contentHash" character varying(64) NOT NULL, "targetLang" character varying(32) NOT NULL, "text" text, "sourceLangs" jsonb NOT NULL DEFAULT '[]', "provider" character varying(32) NOT NULL, "model" character varying(256) NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_kyunet_translation" PRIMARY KEY ("contentHash", "targetLang"))`);
        await queryRunner.query(`COMMENT ON COLUMN "kyunet_translation"."contentHash" IS 'sha256 hex of \`\${kind}\\n\${normalizedText}\`'`);
        await queryRunner.query(`COMMENT ON COLUMN "kyunet_translation"."targetLang" IS 'lower-cased BCP 47 tag'`);
        await queryRunner.query(`COMMENT ON COLUMN "kyunet_translation"."text" IS 'null means "nothing to translate"'`);
        await queryRunner.query(`CREATE INDEX "IDX_kyunet_translation_createdAt" ON "kyunet_translation" ("createdAt") `);
    }

    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX "public"."IDX_kyunet_translation_createdAt"`);
        await queryRunner.query(`DROP TABLE "kyunet_translation"`);
        await queryRunner.query(`DROP TABLE "kyunet_translation_setting"`);
    }
}
