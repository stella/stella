import { afterAll, beforeAll, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  capturePgliteDatabaseBaseline,
  createTestPglite,
  type PgliteDatabaseBaseline,
  resetPgliteDatabase,
} from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let baseline: PgliteDatabaseBaseline;

beforeAll(async () => {
  client = await createTestPglite();
  await client.exec(`
    CREATE TABLE public.reset_empty (id integer PRIMARY KEY, value text NOT NULL);
    CREATE TABLE public.reset_populated (id integer PRIMARY KEY);
    INSERT INTO public.reset_populated VALUES (1);
    CREATE FUNCTION public.reset_baseline_trigger_function() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER reset_baseline_trigger BEFORE INSERT ON public.reset_empty
    FOR EACH ROW EXECUTE FUNCTION public.reset_baseline_trigger_function();
  `);
  baseline = await capturePgliteDatabaseBaseline(client);
});

afterAll(async () => {
  await client.close();
});

test("reset restores structural objects and rows touched since the baseline", async () => {
  await client.exec(`
    BEGIN;
    INSERT INTO public.reset_empty VALUES (3, 'rolled back');
    ROLLBACK;
  `);
  await client.exec(`
    INSERT INTO public.reset_empty VALUES (1, 'inserted');
    UPDATE public.reset_empty SET value = 'updated' WHERE id = 1;
    DELETE FROM public.reset_empty WHERE id = 1;
    INSERT INTO public.reset_empty VALUES (2, 'remaining');
    ALTER TABLE public.reset_empty DISABLE TRIGGER reset_baseline_trigger;
    CREATE FUNCTION public.reset_extra_trigger_function() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER reset_extra_trigger BEFORE INSERT ON public.reset_empty
    FOR EACH ROW EXECUTE FUNCTION public.reset_extra_trigger_function();
    CREATE TABLE public.reset_extra_table (id integer);
    INSERT INTO public.reset_extra_table VALUES (1);
    CREATE VIEW public.reset_extra_view AS SELECT id FROM public.reset_extra_table;
    CREATE SEQUENCE public.reset_extra_sequence;
  `);

  expect((await client.query("SELECT * FROM public.reset_empty")).rows).toEqual(
    [{ id: 2, value: "remaining" }],
  );
  expect(
    (
      await client.query<{ identity: string }>(
        "SELECT identity FROM pglite_test_reset.written_tables WHERE identity = 'public.reset_empty'",
      )
    ).rows,
  ).toEqual([{ identity: "public.reset_empty" }]);

  await resetPgliteDatabase(client, baseline);

  const { rows: emptyRows } = await client.query(
    "SELECT * FROM public.reset_empty",
  );
  const { rows: extraObjects } = await client.query<{ name: string }>(`
    SELECT relname AS name FROM pg_class
    WHERE relname IN ('reset_extra_table', 'reset_extra_view', 'reset_extra_sequence')
    UNION ALL
    SELECT proname AS name FROM pg_proc WHERE proname = 'reset_extra_trigger_function'
    UNION ALL
    SELECT tgname AS name FROM pg_trigger WHERE tgname = 'reset_extra_trigger'
  `);
  const { rows: baselineTriggers } = await client.query<{ enabled: string }>(`
    SELECT tgenabled AS enabled FROM pg_trigger
    WHERE tgname = 'reset_baseline_trigger'
  `);
  expect(emptyRows).toEqual([]);
  expect(extraObjects).toEqual([]);
  expect(baselineTriggers).toEqual([{ enabled: "O" }]);
});

test("reset rejects writes to a table populated in the baseline", async () => {
  await client.exec("UPDATE public.reset_populated SET id = 2 WHERE id = 1");

  const rejection = await rejectionOf(resetPgliteDatabase(client, baseline));
  expect(rejection).toHaveProperty(
    "message",
    expect.stringContaining("public.reset_populated"),
  );
});
