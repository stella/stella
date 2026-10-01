import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_ABSENCE_FIELD_KEYS,
  TEXT_ABSENCE_REASON,
  TEXT_ABSENCE_REASONS,
} from "@stll/api-contract/case-law-text-field";

import {
  decisionHasLegalSentenceSql,
  decisionSearchCategorySql,
} from "@/api/lib/case-law/decision-search-metadata-sql";
import { readStoredDecisionTextAbsence } from "@/api/lib/case-law/decision-text";
import {
  storedDecisionTextAbsenceEntriesSql,
  storedDecisionTextAbsenceValidSql,
} from "@/api/lib/case-law/decision-text-sql";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: PGlite;
const dialect = new PgDialect();
beforeAll(async () => {
  client = await createTestPglite();
}, 120_000);
afterAll(async () => {
  await client.close();
});

test("legal sentence presence distinguishes text from absent and non-text metadata", async () => {
  const metadata = [
    {},
    { legalSentence: null },
    { legalSentence: "" },
    { legalSentence: "   " },
    { legalSentence: [] },
    { legalSentence: {} },
    { legalSentence: "Právní věta." },
  ];
  const compiled = dialect.sqlToQuery(sql`
    SELECT ${decisionHasLegalSentenceSql(sql`metadata`)} AS present
    FROM jsonb_array_elements(${JSON.stringify(metadata)}::text::jsonb) AS samples(metadata)
  `);
  const result = await client.query<{ present: boolean }>(
    compiled.sql,
    compiled.params,
  );
  expect(result.rows.map(({ present }) => present)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
    true,
  ]);
});

test("legal sentence presence follows stored absence validation and field semantics", async () => {
  const metadata = [
    {
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        {
          field: "legalSentence",
          reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
        },
      ],
      legalSentence: "Právní věta není k dispozici.",
    },
    {
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        {
          field: "abstract",
          reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
        },
      ],
      legalSentence: "Právní věta.",
    },
    {
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: "malformed",
      legalSentence: "Právní věta.",
    },
    {
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        {
          field: "legalSentence",
          reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
        },
      ],
      legalSentence: "Právní věta.",
    },
    {
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        {
          field: "legalSentence",
          reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
          unexpected: true,
        },
      ],
      legalSentence: "Právní věta.",
    },
    {
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        {
          field: "legalSentence",
          reason: TEXT_ABSENCE_REASON.PARSE_FAILED,
        },
        {
          field: "legalSentence",
          reason: TEXT_ABSENCE_REASON.PUBLISHER_PLACEHOLDER,
        },
      ],
      legalSentence: "Právní věta.",
    },
  ];
  const entries = storedDecisionTextAbsenceEntriesSql(sql`metadata`);
  const compiled = dialect.sqlToQuery(sql`
    SELECT ${decisionHasLegalSentenceSql(sql`metadata`)} AS present,
           ${storedDecisionTextAbsenceValidSql(sql`metadata`, entries)} AS absence_valid
      FROM jsonb_array_elements(${JSON.stringify(metadata)}::text::jsonb) AS samples(metadata)
  `);
  const result = await client.query<{
    present: boolean;
    absence_valid: boolean;
  }>(compiled.sql, compiled.params);

  expect(result.rows).toEqual([
    { present: false, absence_valid: true },
    { present: true, absence_valid: true },
    { present: false, absence_valid: false },
    { present: false, absence_valid: true },
    { present: false, absence_valid: false },
    { present: false, absence_valid: false },
  ]);
});

test("SQL and the reader accept every contracted field and absence reason", async () => {
  const metadata = DECISION_ABSENCE_FIELD_KEYS.flatMap((field) =>
    TEXT_ABSENCE_REASONS.map((reason) => ({
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [{ field, reason }],
    })),
  );
  const entries = storedDecisionTextAbsenceEntriesSql(sql`metadata`);
  const compiled = dialect.sqlToQuery(sql`
    SELECT ${storedDecisionTextAbsenceValidSql(sql`metadata`, entries)} AS valid
      FROM jsonb_array_elements(${JSON.stringify(metadata)}::text::jsonb) AS samples(metadata)
  `);
  const result = await client.query<{ valid: boolean }>(
    compiled.sql,
    compiled.params,
  );
  expect(result.rows).toEqual(
    metadata.map((stored) => ({
      valid: readStoredDecisionTextAbsence(stored).type === "valid",
    })),
  );
  expect(result.rows.every(({ valid }) => valid)).toBe(true);
});

test("categories preserve exact bounded strings and exclude structured metadata", async () => {
  const metadata = [
    {},
    { category: null },
    { category: "A" },
    { category: "a" },
    { category: ["A"] },
    { category: { label: "A" } },
    { category: "A".repeat(129) },
  ];
  const compiled = dialect.sqlToQuery(sql`
    SELECT ${decisionSearchCategorySql(sql`metadata`)} AS category
    FROM jsonb_array_elements(${JSON.stringify(metadata)}::text::jsonb) AS samples(metadata)
  `);
  const result = await client.query<{ category: string | null }>(
    compiled.sql,
    compiled.params,
  );
  expect(result.rows.map(({ category }) => category)).toEqual([
    null,
    null,
    "A",
    "a",
    null,
    null,
    null,
  ]);
});
