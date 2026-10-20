import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL(
    "../../../drizzle/20261020000100_stored_keys_organization_scope/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);

describe("stored object organization key migration", () => {
  test("prechecks every stored-key table before validation", () => {
    for (const table of [
      "templates",
      "template_versions",
      "style_sets",
      "user_files",
    ]) {
      expect(migration).toContain(`FROM public.${table}`);
    }
    expect(migration).toContain(
      "stored object keys must use their organization prefix",
    );
  });

  test("binds mutable keys and keeps user file keys immutable", () => {
    for (const constraint of [
      "templates_s3_key_organization_check",
      "template_versions_s3_key_organization_check",
      "style_sets_s3_key_organization_check",
    ]) {
      expect(migration).toContain(constraint);
    }
    expect(migration).toContain("user_files.s3_key is immutable");
    expect(migration).toContain("BEFORE INSERT OR UPDATE OF s3_key, thread_id");
  });
});
