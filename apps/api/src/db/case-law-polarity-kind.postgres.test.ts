import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { rejectionOf } from "@stll/property-testing/rejection";

import { POLARITY_RULE_KIND } from "@/api/handlers/case-law/polarity/consts";
import { SEED_RULES } from "@/api/handlers/case-law/polarity/seed-rules";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { renderSeedRuleKindBackfill } from "../../scripts/generate-polarity-kind-migration";

const migration = readFileSync(
  new URL(
    "../../drizzle/20261010005100_case_law_polarity_kind_evidence/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);
const databaseUrl = process.env["DATABASE_URL"];
const validationMigration = readFileSync(
  new URL(
    "../../drizzle/20261010005200_case_law_citation_polarity_evidence_validate/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

test("the committed kind backfill is derived from every typed seed", () => {
  expect(migration).toContain(renderSeedRuleKindBackfill());
});

describe.skipIf(!enabled)("persisted polarity rule kinds", () => {
  test("backfills registered forms as neutral and unmatched rows as stance", async () => {
    if (!databaseUrl) {
      throw new TypeError("Postgres test requires DATABASE_URL");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql } = openClient();
      await sql.begin(async (tx) => {
        await tx`CREATE TEMP TABLE deployed_polarity_rules
          (LIKE public.case_law_polarity_rules INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP`;
        await tx`SAVEPOINT deployed_form_check`;
        expect(
          await rejectionOf(tx`INSERT INTO deployed_polarity_rules (id, pattern, language, kind, polarity)
          VALUES (${Bun.randomUUIDv7()}::uuid, 'invalid-form', 'xx', 'form', 'supportive')`),
        ).toHaveProperty("constraint", "polarity_rules_form_neutral");
        await tx`ROLLBACK TO SAVEPOINT deployed_form_check`;
        // Derive the predecessor from the migrated schema, removing only this
        // migration's additions; all other columns and checks remain canonical.
        await tx`CREATE TEMP TABLE case_law_polarity_rules
          (LIKE public.case_law_polarity_rules INCLUDING ALL) ON COMMIT DROP`;
        await tx`ALTER TABLE case_law_polarity_rules DROP COLUMN kind CASCADE`;
        await tx`CREATE TEMP TABLE case_law_citations
          (LIKE public.case_law_citations INCLUDING ALL) ON COMMIT DROP`;
        await tx`ALTER TABLE case_law_citations
          DROP COLUMN polarity_source CASCADE,
          DROP COLUMN polarity_classifier_version CASCADE,
          DROP COLUMN polarity_evidence_windows CASCADE,
          DROP COLUMN polarity_confidence CASCADE,
          DROP COLUMN cited_part CASCADE`;
        const fixtures = JSON.stringify(
          SEED_RULES.map((seed) => ({
            pattern: seed.pattern,
            language: seed.language,
            polarity: "supportive",
          })),
        );
        await tx`INSERT INTO case_law_polarity_rules (id, pattern, language, polarity)
          SELECT gen_random_uuid(), pattern, language, polarity FROM jsonb_to_recordset(${fixtures}::text::jsonb)
          AS seeds(pattern text, language text, polarity text)`;
        await tx`INSERT INTO case_law_polarity_rules (id, pattern, language, polarity) VALUES
          (gen_random_uuid(), 'unregistered-manual', 'xx', 'negative'), (gen_random_uuid(), 'unregistered-model', 'xx', 'supportive')`;
        for (const statement of migration.split("--> statement-breakpoint")) {
          await tx.unsafe(statement);
        }
        const constraints = await tx.unsafe<
          { conname: string; convalidated: boolean }[]
        >(
          "SELECT conname, convalidated FROM pg_constraint WHERE contype = 'c' AND conrelid IN ('pg_temp.case_law_polarity_rules'::regclass, 'pg_temp.case_law_citations'::regclass) AND conname IN ('citations_cited_part_values', 'citations_polarity_confidence_bounds', 'citations_polarity_source_values', 'citations_polarity_window_bounds', 'polarity_rules_form_neutral', 'polarity_rules_kind_values')",
        );
        expect(constraints.length).toBe(6);
        expect(
          constraints.filter((constraint) => constraint.convalidated).length,
        ).toBe(0);
        expect(
          constraints
            .filter((constraint) => !constraint.convalidated)
            .map((constraint) => constraint.conname)
            .toSorted(),
        ).toEqual([
          "citations_cited_part_values",
          "citations_polarity_confidence_bounds",
          "citations_polarity_source_values",
          "citations_polarity_window_bounds",
          "polarity_rules_form_neutral",
          "polarity_rules_kind_values",
        ]);
        for (const statement of validationMigration.split(
          "--> statement-breakpoint",
        )) {
          await tx.unsafe(statement);
        }
        const validatedConstraints = await tx.unsafe<
          { convalidated: boolean }[]
        >(
          "SELECT convalidated FROM pg_constraint WHERE contype = 'c' AND conrelid IN ('pg_temp.case_law_polarity_rules'::regclass, 'pg_temp.case_law_citations'::regclass) AND conname IN ('citations_cited_part_values', 'citations_polarity_confidence_bounds', 'citations_polarity_source_values', 'citations_polarity_window_bounds', 'polarity_rules_form_neutral', 'polarity_rules_kind_values')",
        );
        expect(validatedConstraints.length).toBe(6);
        expect(
          validatedConstraints.every((constraint) => constraint.convalidated),
        ).toBe(true);
        const rows = await tx.unsafe<
          {
            pattern: string;
            language: string;
            kind: string;
            polarity: string;
          }[]
        >(
          "SELECT pattern, language, kind, polarity FROM case_law_polarity_rules ORDER BY pattern, language",
        );
        for (const seed of SEED_RULES) {
          const row = rows.find(
            (candidate) =>
              candidate.pattern === seed.pattern &&
              candidate.language === seed.language,
          );
          expect(row).toMatchObject({
            kind: seed.kind,
            polarity:
              seed.kind === POLARITY_RULE_KIND.FORM ? "neutral" : "supportive",
          });
        }
        expect(rows.filter((row) => row.language === "xx")).toEqual([
          {
            pattern: "unregistered-manual",
            language: "xx",
            polarity: "negative",
            kind: "stance",
          },
          {
            pattern: "unregistered-model",
            language: "xx",
            polarity: "supportive",
            kind: "stance",
          },
        ]);
        for (const polarity of [
          "positive",
          "supportive",
          "negative",
          "mixed",
          "unknown",
        ]) {
          await tx`SAVEPOINT rejected_form`;
          expect(
            await rejectionOf(tx`INSERT INTO case_law_polarity_rules (id, pattern, language, kind, polarity)
            VALUES (gen_random_uuid(), 'invalid-form', 'xx', 'form', ${polarity})`),
          ).toHaveProperty("constraint", "polarity_rules_form_neutral");
          await tx`ROLLBACK TO SAVEPOINT rejected_form`;
        }
        await tx`SAVEPOINT rejected_kind`;
        expect(
          await rejectionOf(tx`INSERT INTO case_law_polarity_rules (id, pattern, language, kind, polarity)
          VALUES (gen_random_uuid(), 'invalid-kind', 'xx', 'other', 'neutral')`),
        ).toHaveProperty("constraint", "polarity_rules_kind_values");
        await tx`ROLLBACK TO SAVEPOINT rejected_kind`;
        await tx`INSERT INTO case_law_polarity_rules (id, pattern, language, kind, polarity)
          VALUES (gen_random_uuid(), 'valid-form', 'xx', 'form', 'neutral'), (gen_random_uuid(), 'valid-stance', 'xx', 'stance', 'supportive')`;
      });
    });
  });
});
