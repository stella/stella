import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR as REPAIR } from "./case-law-source-config-object-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

test("repairs legacy string configs, validates the constraint, and converges", async () => {
  const client = await createTestPglite();
  const connection = {
    execute: async (statement, params = []) => {
      await client.query(statement, [...params]);
    },
    query: async (statement, params = []) =>
      (await client.query(statement, [...params])).rows,
    release: () => {},
  } satisfies OnlineMigrationConnection;

  try {
    await client.exec(`ALTER TABLE public.case_law_sources
      DROP CONSTRAINT case_law_sources_config_object`);
    const id = createSafeId<"caseLawSource">();
    await client.query(
      `INSERT INTO public.case_law_sources (id, adapter_key, name, config)
       VALUES ($1, $2, 'Legacy config fixture', '"{}"'::jsonb)`,
      [id, `config-repair-${id}`],
    );
    // NOT VALID permits existing bad rows but still checks every new write.
    await client.exec(`ALTER TABLE public.case_law_sources
      ADD CONSTRAINT case_law_sources_config_object
      CHECK (jsonb_typeof(config) = 'object') NOT VALID`);

    const readRow = async () =>
      (
        await client.query(
          `SELECT config, jsonb_typeof(config) AS kind, xmin::text AS version
         FROM public.case_law_sources WHERE id = $1`,
          [id],
        )
      ).rows;
    const readValidation = async () =>
      (
        await client.query(
          `SELECT convalidated FROM pg_catalog.pg_constraint
         WHERE conrelid = 'public.case_law_sources'::regclass
           AND conname = 'case_law_sources_config_object'`,
        )
      ).rows;

    expect(await readRow()).toEqual([
      { config: "{}", kind: "string", version: expect.any(String) },
    ]);
    expect(await readValidation()).toEqual([{ convalidated: false }]);
    expect((await REPAIR.readCompletion(connection)).type).toBe("incomplete");

    const tables = createUngatedTableGateForTests(connection);
    expect(await REPAIR.repair(connection, tables)).toEqual({
      type: "complete",
    });
    const repaired = await readRow();
    expect(repaired).toEqual([
      { config: {}, kind: "object", version: expect.any(String) },
    ]);
    expect(await readValidation()).toEqual([{ convalidated: true }]);
    expect(await REPAIR.readCompletion(connection)).toEqual({
      type: "complete",
    });

    expect(await REPAIR.repair(connection, tables)).toEqual({
      type: "complete",
    });
    // xmin also detects an unnecessary rewrite of an already repaired row.
    expect(await readRow()).toEqual(repaired);
    expect(await readValidation()).toEqual([{ convalidated: true }]);
  } finally {
    await client.close();
  }
});
