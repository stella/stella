import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import type { EntityKind } from "@stll/api-contract";

import { LIMITS } from "@/api/lib/limits";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

import { HOT_TABLES, PLACEHOLDER_PROFILE } from "./profile";
import { readSeededProfile, seedProdShaped } from "./seed";
import { SYNTHETIC_TABLES } from "./tables";

const databaseUrl = process.env["QUERY_PERF_FIXTURE_TEST_URL"];
const TASK_KIND = "task" satisfies EntityKind;

// This suite owns an empty, migrated fixture, separate from shared postgres suites.
test.skipIf(!databaseUrl)(
  "bulk fixtures preserve row counts, search coverage and relationship ownership",
  async () => {
    if (!databaseUrl) {
      return;
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const result = await seedProdShaped(db, PLACEHOLDER_PROFILE);
      const { seedMilliseconds, ...seededProfile } = result;
      expect(await readSeededProfile(db, PLACEHOLDER_PROFILE)).toEqual(
        seededProfile,
      );
      expect(result.bigWorkspaceId).not.toBe(result.medianWorkspaceId);
      expect(seedMilliseconds).toBeGreaterThan(0);
      expect(result.searchMatchCount).toBeGreaterThan(
        LIMITS.mcpSearchPageSizeDefault,
      );
      expect(result.documentMatchCount).toBeLessThanOrEqual(
        result.searchMatchCount,
      );
      for (const table of HOT_TABLES) {
        const counts = await db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM ${sql.identifier(table)}`,
        );
        expect(counts.at(0)?.count).toBe(
          PLACEHOLDER_PROFILE.tables[table].rowCount,
        );
      }
      const violations = await db.execute<{ count: number }>(sql`
      SELECT (
        (SELECT count(*) FROM legal_list_items i JOIN entities e ON e.id=i.entity_id WHERE e.kind <> ${TASK_KIND} OR e.workspace_id <> i.workspace_id) +
        (SELECT count(*) FROM legal_list_items i LEFT JOIN legal_lists l ON l.id=i.list_id WHERE l.id IS NULL OR l.workspace_id <> i.workspace_id) +
        (SELECT count(*) FROM legal_list_items i LEFT JOIN legal_list_sections s ON s.id=i.section_id WHERE i.section_id IS NOT NULL AND (s.id IS NULL OR s.list_id <> i.list_id OR s.workspace_id <> i.workspace_id)) +
        (SELECT count(*) FROM legal_list_sections s LEFT JOIN legal_lists l ON l.id=s.list_id WHERE l.id IS NULL OR l.workspace_id <> s.workspace_id) +
        (SELECT count(*) FROM (
          SELECT position, row_number() OVER (PARTITION BY list_id,workspace_id ORDER BY position::bigint)-1 AS expected_position FROM legal_list_items
          UNION ALL
          SELECT position, row_number() OVER (PARTITION BY list_id,workspace_id ORDER BY position::bigint)-1 AS expected_position FROM legal_list_sections
        ) positions WHERE position <> expected_position::text) +
        (SELECT count(*) FROM task_assignees a JOIN entities e ON e.id=a.entity_id WHERE e.kind <> ${TASK_KIND} OR e.workspace_id <> a.workspace_id) +
        (SELECT count(*) FROM entities e LEFT JOIN entity_versions v ON v.id=e.current_version_id WHERE v.id IS NULL OR v.deleted_at IS NOT NULL OR v.entity_id <> e.id OR v.workspace_id <> e.workspace_id)
      )::int AS count`);
      expect(violations.at(0)?.count).toBe(0);
      const tasks = await db.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM entities WHERE kind=${TASK_KIND}`,
      );
      expect(tasks.at(0)?.count).toBe(
        Math.round(PLACEHOLDER_PROFILE.tables.entities.rowCount * 0.4),
      );
      // Leave the dedicated migrated fixture ready for another isolated invocation.
      await db.execute(
        sql`TRUNCATE ${sql.join(
          SYNTHETIC_TABLES.map((table) => sql.identifier(table)),
          sql`, `,
        )} CASCADE`,
      );
    });
  },
  600_000,
);
