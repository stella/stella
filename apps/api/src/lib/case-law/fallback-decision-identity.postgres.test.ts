import { panic, Result } from "better-result";
import { expect, test } from "bun:test";

import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  decisionFallbackColumns,
  decisionStorageIdentity,
} from "@/api/lib/case-law/fallback-decision-identity";
import { FALLBACK_DECISION_IDENTITY_INDEX } from "@/api/lib/case-law/fallback-decision-identity-constants";
import { FALLBACK_DECISION_INDEXES } from "@/api/lib/case-law/fallback-decision-identity-index";
import { EMPTY_AST } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

test.skipIf(!enabled)(
  "known pre-contract expansion preserves rows while content indexes support the contract cutover",
  async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("PostgreSQL URL required for fallback identity test");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: client } = openClient({ max: 1 });
      const schema = `fallback_identity_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const table = `"${schema}".case_law_decisions`;
      await client.unsafe(`CREATE SCHEMA "${schema}"`);
      try {
        await client.unsafe(
          `CREATE TABLE ${table} (LIKE public.case_law_decisions INCLUDING ALL)`,
        );
        await client.unsafe(
          `ALTER TABLE ${table} DROP COLUMN IF EXISTS fallback_identity_key, DROP COLUMN IF EXISTS fallback_cohort_key, DROP COLUMN IF EXISTS fallback_content_hash, DROP COLUMN IF EXISTS fallback_publication_hash`,
        );
        const sourceId = Bun.randomUUIDv7();
        await client.unsafe(
          `INSERT INTO ${table} (id,source_id,case_number,country,court,language,decision_date)
        VALUES ($1,$2,'104 C 16/2024','CZE','Okresní soud v Chrudimi','cs','2025-01-01')`,
          [Bun.randomUUIDv7(), sourceId],
        );
        const before = await client.unsafe(
          `SELECT to_jsonb(d) AS row FROM ${table} d ORDER BY id`,
        );
        const migration = await Bun.file(
          new URL(
            "../../../drizzle/20261029000200_case_law_fallback_identity/migration.sql",
            import.meta.url,
          ),
        ).text();
        await client.unsafe(`SET search_path TO "${schema}",public`);
        for (const statement of migration.split("--> statement-breakpoint")) {
          // db-await-in-loop: apply the shipped expansion to an isolated legacy table.
          if (statement.trim().length > 0) {
            await client.unsafe(statement);
          }
        }
        const baseColumns = await client.unsafe(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='case_law_decisions' ORDER BY column_name",
          [schema],
        );
        for (const view of [
          "case_law_published_decisions",
          "case_law_unredacted_decisions",
        ]) {
          // db-await-in-loop: both shipped projections must mirror the expanded base columns.
          expect(
            await client.unsafe(
              "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name",
              [schema, view],
            ),
          ).toEqual(baseColumns);
        }
        for (const definition of FALLBACK_DECISION_INDEXES) {
          // db-await-in-loop: online indexes are built sequentially outside a transaction.
          await client.unsafe(
            definition.createSql.replace("public.", () => `"${schema}".`),
          );
        }
        expect(
          await client.unsafe(
            `SELECT to_jsonb(d)-'fallback_identity_key'-'fallback_cohort_key'-'fallback_content_hash'-'fallback_publication_hash' AS row FROM ${table} d ORDER BY id`,
          ),
        ).toEqual(before);
        expect(
          (
            await client.unsafe(
              "SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2",
              [schema, FALLBACK_DECISION_IDENTITY_INDEX],
            )
          ).length,
        ).toBe(1);
        const legacyIndex = await client.unsafe(
          "SELECT indexname FROM pg_indexes WHERE schemaname=$1 AND indexdef LIKE '%(source_id, case_number, language)%'",
          [schema],
        );
        expect(legacyIndex.length).toBe(1);
        const oldIndexName = legacyIndex.at(0)?.["indexname"];
        if (typeof oldIndexName !== "string") {
          return panic("Fixture has no legacy fallback index");
        }
        // Only this isolated fixture models the later contract cutover. The
        // expansion itself leaves the old index installed, as proved above.
        await client.unsafe(`DROP INDEX "${schema}"."${oldIndexName}"`);
        const insert = async (
          court: string,
          decisionDate: string,
          fulltext: string,
        ) => {
          const published = plainTextIngestionResult({
            language: "sk",
            country: "SVK",
            court,
            caseNumber: "0Pu/1/2025",
            decisionDate,
            decisionType: "Uznesenie",
            fulltext,
            rawHash: "fixture",
            metadata: {},
            documentAst: EMPTY_AST,
            textFields: absentDecisionTextFields(
              TEXT_ABSENCE_REASON.NOT_PUBLISHED,
            ),
          });
          const columns = decisionFallbackColumns(
            decisionStorageIdentity(published),
          );
          await client.unsafe(
            `INSERT INTO ${table} (id,source_id,case_number,country,court,language,decision_date,decision_type,fallback_identity_key,fallback_cohort_key,fallback_content_hash)
            VALUES ($1,$2,'0Pu/1/2025','SVK',$3,'sk',$4,'Uznesenie',$5,$6,$7)`,
            [
              Bun.randomUUIDv7(),
              sourceId,
              court,
              decisionDate,
              columns.fallbackIdentityKey,
              columns.fallbackCohortKey,
              columns.fallbackContentHash,
            ],
          );
        };
        await insert("Okresný súd Bardejov", "2025-04-18", "Prvé uznesenie.");
        await insert("Mestský súd Košice", "2025-04-18", "Prvé uznesenie.");
        await insert(
          "Mestský súd Košice",
          "2025-04-18",
          "Druhé uznesenie toho istého dňa.",
        );
        await insert("Mestský súd Košice", "2025-05-28", "Ďalšie uznesenie.");
        const duplicate = await Result.tryPromise({
          try: async () =>
            await insert(
              "Mestský súd Košice",
              "2025-05-28",
              "Ďalšie uznesenie.",
            ),
          catch: (cause: unknown) => cause,
        });
        expect(duplicate.isErr()).toBe(true);
        if (duplicate.isErr()) {
          expect(getPgErrorCode(duplicate.error)).toBe(
            PG_ERROR.UNIQUE_VIOLATION,
          );
        }
        expect((await client.unsafe(`SELECT id FROM ${table}`)).length).toBe(5);
      } finally {
        await client.unsafe("SET search_path TO public");
        await client.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      }
    });
  },
);
