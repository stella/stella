import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
}, 120_000);

afterAll(async () => await client.close());

const readDigest = async (country: string): Promise<string> =>
  await withPublicLawReaderRole(db, async (tx) => {
    const result = await tx.execute(sql`
      SELECT public.case_law_provision_extraction_scope_generation_digest(
        ${country}::varchar
      ) AS digest
    `);
    const digest = result.rows.at(0)?.["digest"];
    if (typeof digest !== "string") {
      panic("Expected the public scope generation digest");
    }
    return digest;
  });

const refusalMessage = async (operation: () => Promise<unknown>) => {
  const result = await Result.tryPromise({
    try: operation,
    catch: (cause: unknown) => cause,
  });
  if (Result.isOk(result)) {
    return panic("Expected a database permission error");
  }
  if (result.error instanceof Error) {
    return result.error.message;
  }
  return panic("Expected a database permission error");
};

test("scope digest is ordered, bigint exact, jurisdiction scoped, and execute only", async () => {
  await db.execute(sql`
    INSERT INTO case_law_provision_extraction_scopes
      (country, language, status, generation)
    VALUES
      ('CZE', 'sk', 'retired', 2),
      ('CZE', 'cs', 'active', 1),
      ('SVK', 'cs', 'active', 1),
      ('SVK', 'sk', 'retired', 2)
  `);

  const czechDigest = await readDigest("CZE");
  const slovakDigest = await readDigest("SVK");
  expect(czechDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(czechDigest).toBe(slovakDigest);

  await db.execute(sql`
    UPDATE case_law_provision_extraction_scopes
    SET generation = 9007199254740993
    WHERE country = 'CZE' AND language = 'cs'
  `);
  const advancedCzechDigest = await readDigest("CZE");
  expect(advancedCzechDigest).not.toBe(czechDigest);
  expect(await readDigest("SVK")).toBe(slovakDigest);

  await db.execute(sql`
    INSERT INTO case_law_provision_extraction_scopes
      (country, language, status, generation)
    VALUES ('CZE', 'en', 'active', 1)
  `);
  expect(await readDigest("CZE")).not.toBe(advancedCzechDigest);

  const privileges = await withPublicLawReaderRole(
    db,
    async (tx) =>
      await tx.execute(sql`
      SELECT
        has_function_privilege(
          current_user,
          'public.case_law_provision_extraction_scope_generation_digest(varchar)',
          'EXECUTE'
        ) AS can_execute,
        has_table_privilege(
          current_user,
          'public.case_law_provision_extraction_scopes',
          'SELECT'
        ) AS can_select,
        has_table_privilege(
          current_user,
          'public.case_law_provision_extraction_scopes',
          'INSERT, UPDATE, DELETE'
        ) AS can_write
    `),
  );
  expect(privileges.rows.at(0)).toMatchObject({
    can_execute: true,
    can_select: false,
    can_write: false,
  });

  expect(
    await refusalMessage(
      async () =>
        await withPublicLawReaderRole(
          db,
          async (tx) =>
            await tx.execute(sql`
          SELECT country
          FROM public.case_law_provision_extraction_scopes
        `),
        ),
    ),
  ).toContain("permission denied");
  expect(
    await refusalMessage(
      async () =>
        await withPublicLawReaderRole(
          db,
          async (tx) =>
            await tx.execute(sql`
          UPDATE public.case_law_provision_extraction_scopes
          SET generation = generation + 1
        `),
        ),
    ),
  ).toContain("permission denied");
});
