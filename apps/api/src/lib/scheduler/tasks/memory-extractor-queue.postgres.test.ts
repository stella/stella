import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import {
  buildClaimMemoryExtractionQueueQuery,
  buildSettleMemoryExtractionQueueQuery,
  groupClaimedMemoryExtractionRows,
} from "./memory-extractor-queue";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("memory extraction tenant queue (postgres)", () => {
  test("claims exactly two due organizations and settles only their leases", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const schema = sql.identifier(
        `memory_queue_${Bun.randomUUIDv7().replaceAll("-", "")}`,
      );
      const now = new Date("2026-10-14T12:00:00.000Z");
      const leaseExpiresAt = new Date("2026-10-14T12:30:00.000Z");
      const firstId = mintAuthProviderId<"organization">();
      const secondId = mintAuthProviderId<"organization">();
      const futureId = mintAuthProviderId<"organization">();
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      try {
        // Copy migrated columns without foreign keys or triggers; no fixture
        // writes or queue claims can reach another suite's organizations.
        for (const table of [
          "organization_settings",
          "chat_thread_compactions",
          "chat_threads",
        ]) {
          await db.execute(sql`CREATE TABLE ${schema}.${sql.identifier(table)}
            (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
        }
        await db.execute(sql`SET search_path TO ${schema}, public`);
        await db.execute(sql`INSERT INTO organization_settings (
          id, organization_id, memory_extraction_enabled,
          memory_extraction_enabled_at, memory_extraction_scheduled_at
        ) VALUES
          (${createSafeId<"organizationSettings">()}, ${firstId}, true, ${now}, ${now}),
          (${createSafeId<"organizationSettings">()}, ${secondId}, true, ${now}, ${now}),
          (${createSafeId<"organizationSettings">()}, ${futureId}, true, ${now}, ${leaseExpiresAt})`);

        const claimed = groupClaimedMemoryExtractionRows(
          await db.execute(
            buildClaimMemoryExtractionQueueQuery({ now, leaseExpiresAt }),
          ),
        );
        expect(
          claimed.map(({ organizationId }) => organizationId).toSorted(),
        ).toEqual([firstId, secondId].toSorted());
        expect(
          claimed.every(({ compactions }) => compactions.length === 0),
        ).toBe(true);

        // The excluded organization has the same lease value, so only the
        // multi-id predicate can keep it out of the settlement update.
        const settled = await db.execute<{ organizationId: string }>(sql`
          ${buildSettleMemoryExtractionQueueQuery({
            now,
            leaseExpiresAt,
            organizationIds: claimed.map(
              ({ organizationId }) => organizationId,
            ),
          })}
          RETURNING settings.organization_id AS "organizationId"
        `);
        expect(
          settled.map(({ organizationId }) => organizationId).toSorted(),
        ).toEqual([firstId, secondId].toSorted());
        const pending = await db.execute<{ organizationId: string }>(sql`
          SELECT organization_id AS "organizationId"
          FROM organization_settings
          WHERE memory_extraction_scheduled_at IS NOT NULL
        `);
        expect(pending).toEqual([{ organizationId: futureId }]);
      } finally {
        await db.execute(sql`SET search_path TO public`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  });
});
