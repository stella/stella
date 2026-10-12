import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { createTestPglite } from "@/api/tests/pglite-test-db";

import { renderCitationEvidenceWindowCheck } from "../../../scripts/generate-polarity-kind-migration";
import {
  citationEvidenceWindowsValidSql,
  parseCitationEvidenceWindows,
} from "./citation-evidence";

let client: Awaited<ReturnType<typeof createTestPglite>>;
beforeAll(async () => {
  client = await createTestPglite();
});
afterAll(async () => {
  await client.close();
});

const acceptsInDatabase = async (value: unknown) => {
  const [row] = await drizzle({ client })
    .select({
      accepted: citationEvidenceWindowsValidSql(
        sql`${value === null ? null : JSON.stringify(value)}::text::jsonb`,
      ),
    })
    .from(sql`(SELECT 1) AS evidence_window_probe`);
  return row?.accepted;
};

test("citation evidence window validity agrees with database constraints", async () => {
  await assertProperty(
    "citation evidence window validity agrees with database constraints",
    fc.asyncProperty(
      fc.oneof(
        fc.jsonValue(),
        fc.array(
          fc.record({
            start: fc.integer({ min: -1, max: 2_147_483_647 }),
            end: fc.integer({ min: -1, max: 2_147_483_647 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
      ),
      async (value) => {
        expect(await acceptsInDatabase(value)).toBe(
          Result.try(() => parseCitationEvidenceWindows(value)).isOk(),
        );
      },
    ),
  );
});

test("evidence windows preserve each bound and reject incomplete sets", async () => {
  const windows = [
    { start: 0, end: 10 },
    { start: 50, end: 80 },
  ];
  expect(parseCitationEvidenceWindows(windows)).toEqual(windows);
  expect(await acceptsInDatabase(windows)).toBe(true);
  for (const value of [
    [],
    [{}],
    [{ start: 0, end: 0 }],
    [{ start: 0.5, end: 4 }],
    [{ start: 0, end: 4, text: "extra" }],
    [{ start: 0, end: 2_147_483_648 }],
  ]) {
    expect(await acceptsInDatabase(value)).toBe(false);
  }
});

test("the migration evidence check is rendered by its schema owner", async () => {
  const migration = await Bun.file(
    new URL(
      "../../../drizzle/20261010005100_case_law_polarity_kind_evidence/migration.sql",
      import.meta.url,
    ),
  ).text();
  expect(migration).toContain(renderCitationEvidenceWindowCheck());
});
