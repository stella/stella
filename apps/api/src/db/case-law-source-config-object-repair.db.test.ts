import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR as REPAIR } from "./case-law-source-config-object-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

type PgliteClient = Awaited<ReturnType<typeof createTestPglite>>;

const connectionOver = (client: PgliteClient) =>
  ({
    execute: async (statement, params = []) => {
      await client.query(statement, [...params]);
    },
    query: async (statement, params = []) =>
      (await client.query(statement, [...params])).rows,
    release: () => {},
  }) satisfies OnlineMigrationConnection;

/**
 * The state the migration leaves: the given configs stored as they are, then
 * the constraint added NOT VALID, so it has not checked them.
 */
const seedUnderNotValid = async (
  client: PgliteClient,
  configs: readonly string[],
) => {
  await client.exec(`ALTER TABLE public.case_law_sources
    DROP CONSTRAINT case_law_sources_config_object`);
  const ids: string[] = [];
  for (const config of configs) {
    const id = createSafeId<"caseLawSource">();
    await client.query(
      `INSERT INTO public.case_law_sources (id, adapter_key, name, config)
       VALUES ($1, $2, 'Config fixture', $3::text::jsonb)`,
      [id, `config-repair-${id}`, config],
    );
    ids.push(id);
  }
  await client.exec(`ALTER TABLE public.case_law_sources
    ADD CONSTRAINT case_law_sources_config_object
    CHECK (jsonb_typeof(config) = 'object') NOT VALID`);
  return ids;
};

const readRows = async (client: PgliteClient, ids: readonly string[]) =>
  (
    await client.query(
      `SELECT id, config, xmin::text AS version
       FROM public.case_law_sources WHERE id = ANY($1) ORDER BY id`,
      [ids],
    )
  ).rows;

const readValidation = async (client: PgliteClient) =>
  (
    await client.query(
      `SELECT convalidated FROM pg_catalog.pg_constraint
       WHERE conrelid = 'public.case_law_sources'::regclass
         AND conname = 'case_law_sources_config_object'`,
    )
  ).rows;

// timeout: without a CI snapshot, createTestPglite pushes the full schema first.
test("validates the constraint over object configs without rewriting a row, and converges", async () => {
  const client = await createTestPglite();
  const connection = connectionOver(client);
  try {
    const ids = await seedUnderNotValid(client, [
      "{}",
      '{"unavailableItems":{"item":2}}',
    ]);
    const before = await readRows(client, ids);
    expect(await readValidation(client)).toEqual([{ convalidated: false }]);
    expect((await REPAIR.readCompletion(connection)).type).toBe("incomplete");

    const tables = createUngatedTableGateForTests(connection);
    expect(await REPAIR.repair(connection, tables)).toEqual({
      type: "complete",
    });
    expect(await readValidation(client)).toEqual([{ convalidated: true }]);
    expect(await REPAIR.readCompletion(connection)).toEqual({
      type: "complete",
    });
    // xmin also detects a rewrite: validation only reads the rows.
    expect(await readRows(client, ids)).toEqual(before);

    expect(await REPAIR.repair(connection, tables)).toEqual({
      type: "complete",
    });
    expect(await readRows(client, ids)).toEqual(before);
  } finally {
    await client.close();
  }
}, 120_000);

// timeout: without a CI snapshot, createTestPglite pushes the full schema first.
test("leaves a non-object config in place, so validation surfaces it", async () => {
  const client = await createTestPglite();
  const connection = connectionOver(client);
  try {
    const ids = await seedUnderNotValid(client, ["{}", '"{}"', '"paused"']);
    const before = await readRows(client, ids);

    const tables = createUngatedTableGateForTests(connection);
    expect(await rejectionOf(REPAIR.repair(connection, tables))).toMatchObject({
      message: expect.stringContaining("case_law_sources_config_object"),
    });
    expect(await readRows(client, ids)).toEqual(before);
    expect(await readValidation(client)).toEqual([{ convalidated: false }]);
    expect((await REPAIR.readCompletion(connection)).type).toBe("incomplete");
  } finally {
    await client.close();
  }
}, 120_000);
