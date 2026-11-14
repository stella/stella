import { expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR as REPAIR } from "./case-law-source-config-object-repair";
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

const seedSources = async (
  client: PgliteClient,
  configs: readonly (string | null)[],
) => {
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
  return ids;
};

const readRows = async (client: PgliteClient, ids: readonly string[]) =>
  (
    await client.query<{ id: string; config: unknown; version: string }>(
      `SELECT id, config, xmin::text AS version
       FROM public.case_law_sources WHERE id = ANY($1) ORDER BY id`,
      [ids],
    )
  ).rows;

// timeout: without a CI snapshot, createTestPglite pushes the full schema first.
test('stores the object a JSON string "{}" meant, leaves every other row unwritten, and converges', async () => {
  const client = await createTestPglite();
  const connection = connectionOver(client);
  try {
    const ids = await seedSources(client, [
      '"{}"',
      '"{}"',
      "{}",
      '{"unavailableItems":{"item":2}}',
      '"paused"',
      null,
    ]);
    const before = await readRows(client, ids);
    expect((await REPAIR.readCompletion(connection)).type).toBe("incomplete");

    expect(await REPAIR.repair(connection)).toEqual({
      type: "complete",
    });
    expect(await REPAIR.readCompletion(connection)).toEqual({
      type: "complete",
    });
    const after = await readRows(client, ids);
    // xmin also shows that no other row was rewritten.
    expect(after).toEqual(
      before.map((row) =>
        row.config === "{}"
          ? { id: row.id, config: {}, version: expect.any(String) }
          : row,
      ),
    );

    // A retried run finds nothing to rewrite.
    expect(await REPAIR.repair(connection)).toEqual({
      type: "complete",
    });
    expect(await readRows(client, ids)).toEqual(after);
  } finally {
    await client.close();
  }
}, 120_000);

// timeout: without a CI snapshot, createTestPglite pushes the full schema first.
test("reports a database without legacy string configs as complete", async () => {
  const client = await createTestPglite();
  const connection = connectionOver(client);
  try {
    await seedSources(client, ["{}", null]);
    expect(await REPAIR.readCompletion(connection)).toEqual({
      type: "complete",
    });
  } finally {
    await client.close();
  }
}, 120_000);
