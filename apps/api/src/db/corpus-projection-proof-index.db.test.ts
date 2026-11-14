import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestPglite } from "@/api/tests/pglite-test-db";

import proofIndexEntry from "./online-migration-entries/indexes-corpus-index-projection-intents-proof-idx";
import unprovenIndexEntry from "./online-migration-entries/indexes-corpus-index-projection-intents-unproven-idx";

let client: Awaited<ReturnType<typeof createTestPglite>>;

beforeAll(async () => {
  client = await createTestPglite();
});

afterAll(async () => {
  await client.close();
});

test.each([proofIndexEntry, unprovenIndexEntry])(
  "the online declaration $id matches the index the schema declares",
  async (entry) => {
    const declared =
      entry.values.at(0) ?? panic("The online entry declares no index");
    const row = (
      await client.query<{ definition: string }>(
        "SELECT pg_get_indexdef($1::regclass) AS definition",
        [declared.name],
      )
    ).rows.at(0);
    expect(row?.definition).toBe(
      `CREATE INDEX ${declared.name} ${declared.definitionBody}`,
    );
  },
);
