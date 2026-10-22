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
    CREATE TABLE public.pglite_reset_empty (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
    CREATE TABLE public.pglite_reset_occupied (value text NOT NULL);
    INSERT INTO public.pglite_reset_occupied VALUES ('baseline');
    CREATE FUNCTION public.pglite_reset_baseline_trigger_function()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER pglite_reset_baseline_trigger
      BEFORE INSERT ON public.pglite_reset_empty
      FOR EACH ROW EXECUTE FUNCTION public.pglite_reset_baseline_trigger_function();
    ALTER TABLE public.pglite_reset_empty DISABLE TRIGGER pglite_reset_baseline_trigger;
  `);
  baseline = await capturePgliteDatabaseBaseline(client);
});

afterAll(async () => {
  await client.close();
});

test("reset removes added objects and rows and restores trigger state", async () => {
  await client.exec(`
    ALTER TABLE public.pglite_reset_empty ENABLE TRIGGER pglite_reset_baseline_trigger;
    INSERT INTO public.pglite_reset_empty OVERRIDING SYSTEM VALUE VALUES (7);
    CREATE TABLE public.pglite_reset_extra_table (id integer);
    CREATE FUNCTION public.pglite_reset_extra_function()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
    CREATE TRIGGER pglite_reset_extra_trigger
      BEFORE INSERT ON public.pglite_reset_extra_table
      FOR EACH ROW EXECUTE FUNCTION public.pglite_reset_extra_function();
  `);

  await resetPgliteDatabase(client, baseline);

  const objects = await client.query<{
    empty_rows: number;
    extra_function: string | null;
    extra_table: string | null;
    trigger_enabled: string;
  }>(`
    SELECT
      (SELECT count(*)::integer FROM public.pglite_reset_empty) AS empty_rows,
      to_regprocedure('public.pglite_reset_extra_function()')::text AS extra_function,
      to_regclass('public.pglite_reset_extra_table')::text AS extra_table,
      (SELECT tgenabled::text FROM pg_trigger
       WHERE tgname = 'pglite_reset_baseline_trigger') AS trigger_enabled
  `);
  expect(objects.rows).toEqual([
    {
      empty_rows: 0,
      extra_function: null,
      extra_table: null,
      trigger_enabled: "D",
    },
  ]);
});

test("reset panics with the changed baseline table name", async () => {
  await client.exec(
    "UPDATE public.pglite_reset_occupied SET value = 'changed'",
  );

  expect(
    String(await rejectionOf(resetPgliteDatabase(client, baseline))),
  ).toContain("tables:public.pglite_reset_occupied");

  await client.exec(
    "UPDATE public.pglite_reset_occupied SET value = 'baseline'",
  );
});
