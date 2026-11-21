import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { parseDesktopRegistryMetadata } from "@/api/lib/business-registries/desktop/config";

const migration = readFileSync(
  new URL(
    "../../drizzle/20261010005000_disable_legacy_desktop_credentials/migration.sql",
    import.meta.url,
  ),
  "utf-8",
).replaceAll("--> statement-breakpoint", "");

test("desktop metadata without a device binding remains inadmissible", () => {
  const legacy = {
    purpose: "desktop-registry",
    organizationId: "fixture-org",
    inactivityExpiresAt: "2026-10-10T12:00:00.000Z",
  };
  expect(parseDesktopRegistryMetadata(legacy).success).toBe(false);
  expect(
    parseDesktopRegistryMetadata({ ...legacy, deviceJkt: "A".repeat(43) })
      .success,
  ).toBe(true);
});

test("rollout disables prior desktop credentials without parsing metadata and preserves other keys", async () => {
  await using database = new PGlite();
  await database.exec(`CREATE TABLE public.apikey (
    id text PRIMARY KEY, config_id text NOT NULL, enabled boolean NOT NULL, metadata text
  );
  INSERT INTO public.apikey VALUES
    ('legacy', 'desktop-registry', true, '{"purpose":"desktop-registry"}'),
    ('malformed', 'desktop-registry', true, 'not json'),
    ('absent', 'desktop-registry', true, NULL),
    ('already-disabled', 'desktop-registry', false, 'not json'),
    ('other', 'default', true, 'not json');`);
  await database.exec(migration);
  const rows = await database.query(
    "SELECT id, enabled FROM public.apikey ORDER BY id",
  );
  expect(rows.rows).toEqual([
    { id: "absent", enabled: false },
    { id: "already-disabled", enabled: false },
    { id: "legacy", enabled: false },
    { id: "malformed", enabled: false },
    { id: "other", enabled: true },
  ]);
  await database.exec(migration);
  expect(
    (await database.query("SELECT id, enabled FROM public.apikey ORDER BY id"))
      .rows,
  ).toEqual(rows.rows);
  await database.exec(
    "INSERT INTO public.apikey VALUES ('new-device-bound', 'desktop-registry', true, NULL)",
  );
  expect(
    (
      await database.query(
        "SELECT enabled FROM public.apikey WHERE id = 'new-device-bound'",
      )
    ).rows,
  ).toEqual([{ enabled: true }]);
});
