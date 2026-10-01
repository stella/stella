import { expect, test } from "bun:test";

import { createTestPglite } from "@/api/tests/pglite-test-db";

test("file snapshot clones retain their seed and isolate rows, DDL, and clocks", async () => {
  const template = await createTestPglite();
  const snapshot = await (async () => {
    try {
      await template.exec(`
        CREATE TABLE snapshot_seed (id integer PRIMARY KEY);
        INSERT INTO snapshot_seed VALUES (1);
      `);
      return await template.dumpDataDir("none");
    } finally {
      await template.close();
    }
  })();

  const first = await createTestPglite(snapshot);
  try {
    await first.exec(`
      INSERT INTO snapshot_seed VALUES (2);
      CREATE FUNCTION snapshot_trigger() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER snapshot_insert BEFORE INSERT ON snapshot_seed
        FOR EACH ROW EXECUTE FUNCTION snapshot_trigger();
      CREATE FUNCTION public.clock_timestamp() RETURNS timestamptz
        LANGUAGE sql AS $$ SELECT '2000-01-01T00:00:00Z'::timestamptz $$;
      SET search_path = public, pg_catalog;
    `);
    expect(
      (
        await first.query(
          "SELECT tgname FROM pg_trigger WHERE tgname = 'snapshot_insert'",
        )
      ).rows,
    ).toEqual([{ tgname: "snapshot_insert" }]);
    expect(
      (await first.query("SELECT id FROM snapshot_seed ORDER BY id")).rows,
    ).toEqual([{ id: 1 }, { id: 2 }]);
    expect(
      (
        await first.query(
          "SELECT extract(year FROM clock_timestamp())::integer AS year",
        )
      ).rows,
    ).toEqual([{ year: 2000 }]);
  } finally {
    await first.close();
  }

  const second = await createTestPglite(snapshot);
  try {
    expect(
      (await second.query("SELECT id FROM snapshot_seed ORDER BY id")).rows,
    ).toEqual([{ id: 1 }]);
    expect(
      (
        await second.query(
          "SELECT to_regprocedure('public.snapshot_trigger()') AS function",
        )
      ).rows,
    ).toEqual([{ function: null }]);
    expect(
      (
        await second.query(
          "SELECT tgname FROM pg_trigger WHERE tgname = 'snapshot_insert'",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await second.query(
          "SELECT to_regprocedure('public.clock_timestamp()') AS function",
        )
      ).rows,
    ).toEqual([{ function: null }]);
  } finally {
    await second.close();
  }
});
