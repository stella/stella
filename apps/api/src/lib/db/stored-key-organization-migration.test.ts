import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const scopeMigration = readFileSync(
  new URL(
    "../../../drizzle/20261020000100_stored_keys_organization_scope/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);
const validationMigration = readFileSync(
  new URL(
    "../../../drizzle/20261020000200_stored_keys_organization_scope_validate/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);
const migration = `${scopeMigration}\n${validationMigration}`;

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const ORGANIZATION_ID = "018f0000-0000-7000-8000-000000000001";
const OTHER_ORGANIZATION_ID = "018f0000-0000-7000-8000-000000000002";
const USER_ID = "018f0000-0000-7000-8000-000000000003";
const THREAD_ID = "018f0000-0000-7000-8000-000000000004";
const LEGACY_FILE_ID = "018f0000-0000-7000-8000-000000000005";
const SAME_ORGANIZATION_THREAD_ID = "018f0000-0000-7000-8000-000000000006";
const OTHER_ORGANIZATION_THREAD_ID = "018f0000-0000-7000-8000-000000000007";

let database: PGlite;

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

  test("accepts stored uploader keys only during the existing-row precheck", () => {
    expect(migration).toContain(
      "AND NOT starts_with(uf.s3_key, uf.user_id || '/')",
    );
    expect(migration).toContain(
      "AND (TG_OP = 'INSERT' OR NOT starts_with(NEW.s3_key, NEW.user_id || '/'))",
    );
    expect(migration).toContain(
      "NOT starts_with(NEW.s3_key, owning_organization_id || '/')",
    );
  });
});

describe.skipIf(!enabled)(
  "stored object organization key database rules",
  () => {
    beforeAll(async () => {
      database = new PGlite();
      await database.exec(`
      CREATE TABLE public.templates (s3_key text NOT NULL, organization_id text NOT NULL);
      CREATE TABLE public.template_versions (s3_key text NOT NULL, organization_id text NOT NULL);
      CREATE TABLE public.style_sets (s3_key text NOT NULL, organization_id text NOT NULL);
      CREATE TABLE public.chat_threads (id uuid PRIMARY KEY, organization_id text NOT NULL);
      CREATE TABLE public.user_files (
        id uuid PRIMARY KEY,
        user_id text NOT NULL,
        thread_id uuid NOT NULL REFERENCES public.chat_threads(id),
        s3_key text NOT NULL
      );
      INSERT INTO public.chat_threads (id, organization_id)
        VALUES ('${THREAD_ID}', '${ORGANIZATION_ID}'),
          ('${SAME_ORGANIZATION_THREAD_ID}', '${ORGANIZATION_ID}'),
          ('${OTHER_ORGANIZATION_THREAD_ID}', '${OTHER_ORGANIZATION_ID}');
      INSERT INTO public.user_files (id, user_id, thread_id, s3_key)
        VALUES ('${LEGACY_FILE_ID}', '${USER_ID}', '${THREAD_ID}', '${USER_ID}/${LEGACY_FILE_ID}.pdf');
    `);
      await database.exec(migration);
    });

    afterAll(async () => await database.close());

    test("an existing uploader-owned row survives the migration precheck", async () => {
      expect(
        (
          await database.query<{ s3_key: string }>(
            "SELECT s3_key FROM public.user_files WHERE id = $1",
            [LEGACY_FILE_ID],
          )
        ).rows,
      ).toEqual([{ s3_key: `${USER_ID}/${LEGACY_FILE_ID}.pdf` }]);
    });

    test.each([
      ["an uploader-owned key", `${USER_ID}/${Bun.randomUUIDv7()}.pdf`],
      [
        "a key owned by another organization",
        `${OTHER_ORGANIZATION_ID}/${Bun.randomUUIDv7()}.pdf`,
      ],
    ])("refuses %s on a new row", async (_description, s3Key) => {
      const rejection = await database
        .query(
          "INSERT INTO public.user_files (id, user_id, thread_id, s3_key) VALUES ($1, $2, $3, $4)",
          [Bun.randomUUIDv7(), USER_ID, THREAD_ID, s3Key],
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(rejection).toMatchObject({
        message: expect.stringContaining(
          "user_files.s3_key must use its organization prefix",
        ),
      });
    });

    test("refuses moving an uploader-owned row to another organization's thread", async () => {
      const rejection = await database
        .query("UPDATE public.user_files SET thread_id = $1 WHERE id = $2", [
          OTHER_ORGANIZATION_THREAD_ID,
          LEGACY_FILE_ID,
        ])
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(rejection).toMatchObject({
        message: expect.stringContaining(
          "user_files cannot move to another organization",
        ),
      });
    });

    test("keeps an uploader-owned row movable within its organization", async () => {
      await database.query(
        "UPDATE public.user_files SET thread_id = $1 WHERE id = $2",
        [SAME_ORGANIZATION_THREAD_ID, LEGACY_FILE_ID],
      );
      expect(
        (
          await database.query<{ thread_id: string }>(
            "SELECT thread_id FROM public.user_files WHERE id = $1",
            [LEGACY_FILE_ID],
          )
        ).rows,
      ).toEqual([{ thread_id: SAME_ORGANIZATION_THREAD_ID }]);
    });

    test("refuses an update that changes the stored key", async () => {
      const rejection = await database
        .query("UPDATE public.user_files SET s3_key = $1 WHERE id = $2", [
          `${ORGANIZATION_ID}/${Bun.randomUUIDv7()}.pdf`,
          LEGACY_FILE_ID,
        ])
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(rejection).toMatchObject({
        message: expect.stringContaining("user_files.s3_key is immutable"),
      });
    });
  },
);
