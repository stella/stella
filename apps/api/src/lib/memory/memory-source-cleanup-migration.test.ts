import { expect, test } from "bun:test";

const migration = await Bun.file(
  new URL(
    "../../../drizzle/20260808012000_ai_memory_source_cleanup/migration.sql",
    import.meta.url,
  ),
).text();
const schemaMigration = await Bun.file(
  new URL(
    "../../../drizzle/20260808005000_ai_memory/migration.sql",
    import.meta.url,
  ),
).text();

test("source matter deletion erases every provenance-linked memory", () => {
  expect(migration).toContain("SECURITY DEFINER");
  expect(migration).toContain("BEFORE DELETE ON public.workspaces");
  expect(migration).toContain("organization_id = OLD.organization_id");
  expect(migration).toContain(
    "source_data_workspace_ids @> ARRAY[OLD.id]::uuid[]",
  );
  expect(schemaMigration).toContain(
    'ON "ai_memories" USING gin ("source_data_workspace_ids")',
  );
});
