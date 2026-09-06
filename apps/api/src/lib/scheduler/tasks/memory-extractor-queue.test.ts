import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";

import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId, SafeIdType } from "@/api/lib/branded-types";

import {
  buildClaimMemoryExtractionQueueQuery,
  buildSettleMemoryExtractionQueueQuery,
  interleaveClaimedMemoryCompactions,
  MEMORY_EXTRACTION_BATCH_SIZE,
  MEMORY_EXTRACTION_ORGANIZATION_BATCH_SIZE,
  MEMORY_EXTRACTION_PER_ORGANIZATION_LIMIT,
  type ClaimedMemoryExtractionOrganization,
  type QueuedMemoryCompaction,
} from "./memory-extractor-queue";

const dialect = new PgDialect();

describe("memory extraction tenant queue", () => {
  test("bounds tenant claims before every per-tenant compaction seek", () => {
    const query = dialect.sqlToQuery(
      buildClaimMemoryExtractionQueueQuery({
        leaseExpiresAt: new Date("2026-07-31T00:30:00.000Z"),
        now: new Date("2026-07-31T00:00:00.000Z"),
      }),
    );
    const tenantLimit = query.sql.indexOf("LIMIT");
    const lateralSeek = query.sql.indexOf("LEFT JOIN LATERAL");
    const perTenantLimit = query.sql.indexOf("LIMIT", lateralSeek);

    expect(query.sql).toContain("due_organizations AS MATERIALIZED");
    expect(query.sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(tenantLimit).toBeGreaterThan(-1);
    expect(tenantLimit).toBeLessThan(lateralSeek);
    expect(perTenantLimit).toBeGreaterThan(lateralSeek);
    expect(query.sql).toContain(
      "compaction.memory_extraction_organization_id = due.organization_id",
    );
    expect(query.sql).toContain(
      "compaction.memory_extraction_consent_at = due.memory_extraction_enabled_at",
    );
    expect(query.sql).toContain(
      "candidate.memory_extraction_data_workspace_ids",
    );
    expect(query.sql).not.toContain("thread.data_workspace_ids");
    expect(query.sql).not.toContain("row_number");
    expect(query.params).toContain(MEMORY_EXTRACTION_ORGANIZATION_BATCH_SIZE);
    expect(query.params).toContain(MEMORY_EXTRACTION_PER_ORGANIZATION_LIMIT);
  });

  test("interleaves bounded quotas even for adversarially large tenant inputs", () => {
    const organizations = Array.from(
      { length: MEMORY_EXTRACTION_ORGANIZATION_BATCH_SIZE + 4 },
      (_, organizationIndex) =>
        claimedOrganization(
          organizationIndex,
          MEMORY_EXTRACTION_PER_ORGANIZATION_LIMIT + 5,
        ),
    );

    const selected = interleaveClaimedMemoryCompactions(organizations);
    const counts = new Map<string, number>();
    for (const compaction of selected) {
      counts.set(
        compaction.threadOrganizationId,
        (counts.get(compaction.threadOrganizationId) ?? 0) + 1,
      );
    }

    expect(selected).toHaveLength(MEMORY_EXTRACTION_BATCH_SIZE);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(
      MEMORY_EXTRACTION_PER_ORGANIZATION_LIMIT,
    );
    expect(counts.size).toBe(MEMORY_EXTRACTION_ORGANIZATION_BATCH_SIZE);
    expect(
      selected
        .slice(0, MEMORY_EXTRACTION_ORGANIZATION_BATCH_SIZE)
        .map(({ threadOrganizationId }) => threadOrganizationId),
    ).toEqual(
      organizations
        .slice(0, MEMORY_EXTRACTION_ORGANIZATION_BATCH_SIZE)
        .map(({ organizationId }) => organizationId),
    );
  });

  test("settles by lease token without erasing a concurrent trigger wakeup", () => {
    const organizationId = safeId<"organization">(1);
    const leaseExpiresAt = new Date("2026-07-31T00:30:00.000Z");
    const query = dialect.sqlToQuery(
      buildSettleMemoryExtractionQueueQuery({
        leaseExpiresAt,
        now: new Date("2026-07-31T00:10:00.000Z"),
        organizationIds: [organizationId],
      }),
    );

    expect(query.sql).toContain("settings.memory_extraction_scheduled_at = $3");
    expect(query.sql).toContain(
      "compaction.memory_extraction_organization_id = settings.organization_id",
    );
    expect(query.sql).toContain(
      "compaction.memory_extraction_consent_at = settings.memory_extraction_enabled_at",
    );
    expect(query.sql).toContain("LIMIT 1");
    expect(query.params).toContainEqual([organizationId]);
    expect(query.params).toContain(leaseExpiresAt);
  });

  // The ids ride in as one array parameter, so the statement a two-tenant pass
  // sends is character-for-character the statement a one-tenant pass sends.
  // A bare array would be expanded into one bind per id, putting `::text[]` on
  // the last of them and changing the shape with the batch.
  test("settles a whole claimed batch with one statement shape", () => {
    const leaseExpiresAt = new Date("2026-07-31T00:30:00.000Z");
    const now = new Date("2026-07-31T00:10:00.000Z");
    const organizationIds = [
      safeId<"organization">(1),
      safeId<"organization">(2),
    ];

    const batch = dialect.sqlToQuery(
      buildSettleMemoryExtractionQueueQuery({
        leaseExpiresAt,
        now,
        organizationIds,
      }),
    );
    const single = dialect.sqlToQuery(
      buildSettleMemoryExtractionQueueQuery({
        leaseExpiresAt,
        now,
        organizationIds: [organizationIds[0] ?? safeId<"organization">(1)],
      }),
    );

    expect(batch.sql).toBe(single.sql);
    expect(batch.sql).toContain("settings.organization_id = ANY(");
    expect(batch.sql).toContain("::text[])");
    // The compare-and-set stays per row, so one tenant's stale lease cannot
    // settle another's.
    expect(batch.sql).toContain("settings.memory_extraction_scheduled_at = $3");
    expect(batch.params).toContainEqual(organizationIds);
  });
});

const claimedOrganization = (
  organizationIndex: number,
  compactionCount: number,
): ClaimedMemoryExtractionOrganization => {
  const organizationId = safeId<"organization">(organizationIndex + 1);
  return {
    organizationId,
    compactions: Array.from({ length: compactionCount }, (_, index) =>
      compaction({
        compactionIndex: organizationIndex * 100 + index + 1,
        organizationId,
      }),
    ),
  };
};

const compaction = ({
  compactionIndex,
  organizationId,
}: {
  compactionIndex: number;
  organizationId: SafeId<"organization">;
}): QueuedMemoryCompaction => ({
  compactionId: safeId<"chatThreadCompaction">(compactionIndex),
  compactionCreatedAt: new Date(compactionIndex),
  firstSummarizedMessageId: safeId<"chatMessage">(compactionIndex + 1000),
  sourceMessageId: safeId<"chatMessage">(compactionIndex + 2000),
  summaryMarkdown: "summary",
  threadDataWorkspaceIds: [],
  threadId: safeId<"chatThread">(compactionIndex),
  threadOrganizationId: organizationId,
  threadUserId: safeId<"user">(compactionIndex),
  threadWorkspaceId: null,
});

const safeId = <T extends SafeIdType>(index: number) =>
  toSafeId<T>(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
