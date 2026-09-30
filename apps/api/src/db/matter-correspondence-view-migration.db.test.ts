import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { getDefaultViews } from "@/api/lib/views";
import { parseStoredViewLayout } from "@/api/lib/views-schema";

/**
 * The correspondence-view backfill, applied to matters as deployments hold
 * them. The shared test database boots the current schema, so only this file
 * runs the migration against rows that predate it. Only what the migration
 * reads and writes is declared.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20261003122700_matter_correspondence_view/migration.sql",
);

const MATTER = {
  defaults: "018f0000-0000-7000-8000-00000000000a",
  hasOne: "018f0000-0000-7000-8000-00000000000b",
  empty: "018f0000-0000-7000-8000-00000000000c",
  deleting: "018f0000-0000-7000-8000-00000000000d",
  archived: "018f0000-0000-7000-8000-00000000000e",
} as const;

const PRE_MIGRATION = `
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE workspace_views (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name varchar(256) NOT NULL,
  layout jsonb NOT NULL,
  position integer NOT NULL
);
INSERT INTO workspaces (id, status) VALUES
  ('${MATTER.defaults}', 'active'),
  ('${MATTER.hasOne}', 'active'),
  ('${MATTER.empty}', 'active'),
  ('${MATTER.deleting}', 'deleting'),
  ('${MATTER.archived}', 'archived');
INSERT INTO workspace_views (id, workspace_id, name, layout, position) VALUES
  ('018f0000-0000-7000-8000-000000000101', '${MATTER.defaults}', 'Overview', '{"type":"overview"}', 0),
  ('018f0000-0000-7000-8000-000000000102', '${MATTER.defaults}', 'Table', '{"type":"table"}', 1),
  ('018f0000-0000-7000-8000-000000000103', '${MATTER.defaults}', 'Files', '{"type":"filesystem"}', 7),
  ('018f0000-0000-7000-8000-000000000201', '${MATTER.hasOne}', 'Overview', '{"type":"overview"}', 0),
  ('018f0000-0000-7000-8000-000000000202', '${MATTER.hasOne}', 'Client mail', '{"type":"correspondence"}', 1),
  ('018f0000-0000-7000-8000-000000000203', '${MATTER.hasOne}', 'Table', '{"type":"table"}', 2),
  ('018f0000-0000-7000-8000-000000000401', '${MATTER.deleting}', 'Overview', '{"type":"overview"}', 0),
  ('018f0000-0000-7000-8000-000000000501', '${MATTER.archived}', 'Overview', '{"type":"overview"}', 3);
`;

/** PGlite runs the file as one script; the breakpoints are the migrator's. */
const migrationSql = readFileSync(MIGRATION_PATH, "utf-8").replaceAll(
  "--> statement-breakpoint",
  "",
);

type ViewRow = {
  workspace_id: string;
  name: string;
  layout: unknown;
  position: number;
};

const correspondenceViews = async (database: PGlite) =>
  (
    await database.query<ViewRow>(
      `SELECT workspace_id, name, layout, position FROM workspace_views
        WHERE layout ->> 'type' = 'correspondence'
        ORDER BY workspace_id`,
    )
  ).rows;

const allViewIds = async (database: PGlite) =>
  (
    await database.query<{ id: string; name: string; position: number }>(
      "SELECT id, name, position FROM workspace_views ORDER BY id",
    )
  ).rows;

test("appends one correspondence view to each matter that lacks one, and replays", async () => {
  const database = new PGlite();
  try {
    await database.exec(PRE_MIGRATION);
    const before = await allViewIds(database);

    await database.exec(migrationSql);
    const afterFirstRun = await correspondenceViews(database);
    // A retried deployment runs the file again.
    await database.exec(migrationSql);

    expect(await correspondenceViews(database)).toEqual(afterFirstRun);
    expect(
      afterFirstRun.map(({ workspace_id, name, position }) => ({
        workspace_id,
        name,
        position,
      })),
    ).toEqual([
      // After the matter's last view, even when positions have gaps.
      { workspace_id: MATTER.defaults, name: "Correspondence", position: 8 },
      // Already had one: kept as the user named and placed it.
      { workspace_id: MATTER.hasOne, name: "Client mail", position: 1 },
      { workspace_id: MATTER.empty, name: "Correspondence", position: 0 },
      { workspace_id: MATTER.archived, name: "Correspondence", position: 4 },
    ]);

    // Existing rows are untouched; only the new views were added.
    const after = await allViewIds(database);
    expect(after.filter((row) => before.some((b) => b.id === row.id))).toEqual(
      before,
    );
    expect(after).toHaveLength(before.length + 3);
  } finally {
    await database.close();
  }
});

test("writes the same view a new matter is seeded with", async () => {
  const database = new PGlite();
  try {
    await database.exec(PRE_MIGRATION);
    await database.exec(migrationSql);

    const seeded = getDefaultViews("en").find(
      (view) => view.layout.type === "correspondence",
    );
    const inserted = (await correspondenceViews(database)).find(
      (row) => row.workspace_id === MATTER.empty,
    );

    expect(inserted?.name).toBe(seeded?.name);
    // Byte-level parity with the seed, and the stored row reads back.
    expect(inserted?.layout).toEqual(seeded?.layout);
    expect(parseStoredViewLayout(inserted?.layout)).toEqual(seeded?.layout);
  } finally {
    await database.close();
  }
});
