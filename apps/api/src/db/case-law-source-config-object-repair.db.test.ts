import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  CASE_LAW_SOURCE_CONFIG_OBJECT_CONSTRAINT,
  CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR,
} from "./case-law-source-config-object-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

type PgliteClient = Awaited<ReturnType<typeof createTestPglite>>;

const connectionOver = (client: PgliteClient): OnlineMigrationConnection => ({
  execute: async (query, params = []) => {
    await client.query(query, [...params]);
  },
  query: async (query, params = []) =>
    (await client.query(query, [...params])).rows,
  release: () => {},
});

const { constraintName } = CASE_LAW_SOURCE_CONFIG_OBJECT_CONSTRAINT;

/** The state the migration leaves: rows as stored, constraint NOT VALID. */
const seedSources = async (
  client: PgliteClient,
  configs: readonly (string | null)[],
) => {
  await client.query(
    `ALTER TABLE case_law_sources DROP CONSTRAINT "${constraintName}"`,
  );
  const ids: string[] = [];
  for (const config of configs) {
    const id = createSafeId<"caseLawSource">();
    await client.query(
      `INSERT INTO case_law_sources (id, adapter_key, name, config)
       VALUES ($1, $2, 'config repair fixture', $3::text::jsonb)`,
      [id, `config-repair-${id}`, config],
    );
    ids.push(id);
  }
  await client.query(
    `ALTER TABLE case_law_sources ADD CONSTRAINT "${constraintName}"
       CHECK (jsonb_typeof(config) = 'object') NOT VALID`,
  );
  return ids;
};

const readConfigs = async (client: PgliteClient, ids: readonly string[]) =>
  (
    await client.query<{ id: string; config: unknown }>(
      "SELECT id, config FROM case_law_sources WHERE id = ANY($1) ORDER BY id",
      [ids],
    )
  ).rows;

// timeout: each test pushes the full PGlite schema before its first statement.
test('stores the object a JSON string "{}" means, keeps every other row, validates, and converges', async () => {
  const client = await createTestPglite();
  const connection = connectionOver(client);
  const ids = await seedSources(client, [
    '"{}"',
    '"{}"',
    '{"unavailableItems":{"item":2}}',
    "{}",
  ]);
  const before = await readConfigs(client, ids);

  expect(
    (await CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR.readCompletion(connection))
      .type,
  ).toBe("incomplete");
  expect(
    await CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR.repair(
      connection,
      createUngatedTableGateForTests(connection),
    ),
  ).toEqual({ type: "complete" });
  expect(
    (await CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR.readCompletion(connection))
      .type,
  ).toBe("complete");

  const after = await readConfigs(client, ids);
  expect(after).toEqual(
    before.map((row) => ({
      id: row.id,
      config: row.config === "{}" ? {} : row.config,
    })),
  );

  // A retried run finds nothing to rewrite and leaves every row as it is.
  expect(
    await CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR.repair(
      connection,
      createUngatedTableGateForTests(connection),
    ),
  ).toEqual({ type: "complete" });
  expect(await readConfigs(client, ids)).toEqual(after);
  await client.close();
}, 120_000);

// timeout: each test pushes the full PGlite schema before its first statement.
test("leaves any other non-object row in place, so validation surfaces it", async () => {
  const client = await createTestPglite();
  const connection = connectionOver(client);
  const ids = await seedSources(client, ['"{}"', '"paused"', "[]"]);
  const before = await readConfigs(client, ids);

  const rejection = await rejectionOf(
    CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR.repair(
      connection,
      createUngatedTableGateForTests(connection),
    ),
  );
  expect(String(rejection)).toContain(constraintName);

  const after = await readConfigs(client, ids);
  expect(after).toEqual(
    before.map((row) => ({
      id: row.id,
      config: row.config === "{}" ? {} : row.config,
    })),
  );
  expect(
    (await CASE_LAW_SOURCE_CONFIG_OBJECT_REPAIR.readCompletion(connection))
      .type,
  ).toBe("incomplete");
  await client.close();
}, 120_000);
