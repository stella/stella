import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

export const MEMORY_EXTRACTION_BATCH_SIZE = 25;
export const MEMORY_EXTRACTION_PER_ORGANIZATION_LIMIT = 3;
export const MEMORY_EXTRACTION_ORGANIZATION_BATCH_SIZE = Math.ceil(
  MEMORY_EXTRACTION_BATCH_SIZE / MEMORY_EXTRACTION_PER_ORGANIZATION_LIMIT,
);
export const MEMORY_EXTRACTION_QUEUE_LEASE_MS = 30 * 60_000;

export type QueuedMemoryCompaction = {
  compactionId: SafeId<"chatThreadCompaction">;
  compactionCreatedAt: Date;
  firstSummarizedMessageId: SafeId<"chatMessage">;
  sourceMessageId: SafeId<"chatMessage">;
  summaryMarkdown: string;
  threadDataWorkspaceIds: SafeId<"workspace">[];
  threadId: SafeId<"chatThread">;
  threadOrganizationId: SafeId<"organization">;
  threadUserId: SafeId<"user">;
  threadWorkspaceId: SafeId<"workspace"> | null;
};

export type ClaimedMemoryExtractionOrganization = {
  compactions: QueuedMemoryCompaction[];
  organizationId: SafeId<"organization">;
};

type MemoryExtractionQueueRow = {
  compactionCreatedAt: Date | null;
  compactionId: SafeId<"chatThreadCompaction"> | null;
  firstSummarizedMessageId: SafeId<"chatMessage"> | null;
  organizationId: SafeId<"organization">;
  queueScheduledAt: Date;
  sourceMessageId: SafeId<"chatMessage"> | null;
  summaryMarkdown: string | null;
  threadDataWorkspaceIds: SafeId<"workspace">[] | null;
  threadId: SafeId<"chatThread"> | null;
  threadUserId: string | null;
  threadWorkspaceId: SafeId<"workspace"> | null;
};

type BuildClaimMemoryExtractionQueueQueryOptions = {
  leaseExpiresAt: Date;
  now: Date;
};

/**
 * Claim a bounded tenant page before touching compactions. Each LATERAL seek
 * can inspect at most one tenant's indexed prefix and return at most three
 * rows; there is no all-tenant window or global compaction ranking step.
 */
export const buildClaimMemoryExtractionQueueQuery = ({
  leaseExpiresAt,
  now,
}: BuildClaimMemoryExtractionQueueQueryOptions) => sql<MemoryExtractionQueueRow>`
  WITH due_organizations AS MATERIALIZED (
    SELECT
      settings.organization_id,
      settings.memory_extraction_enabled_at,
      settings.memory_extraction_scheduled_at
    FROM organization_settings AS settings
    WHERE settings.memory_extraction_enabled = true
      AND settings.memory_extraction_enabled_at IS NOT NULL
      AND settings.memory_extraction_scheduled_at <= ${now}
    ORDER BY
      settings.memory_extraction_scheduled_at,
      settings.organization_id
    LIMIT ${MEMORY_EXTRACTION_ORGANIZATION_BATCH_SIZE}
    FOR UPDATE SKIP LOCKED
  ),
  claimed_organizations AS (
    UPDATE organization_settings AS settings
    SET memory_extraction_scheduled_at = ${leaseExpiresAt}
    FROM due_organizations AS due
    WHERE settings.organization_id = due.organization_id
    RETURNING settings.organization_id
  )
  SELECT
    due.organization_id AS "organizationId",
    due.memory_extraction_scheduled_at AS "queueScheduledAt",
    candidate.compaction_id AS "compactionId",
    candidate.compaction_created_at AS "compactionCreatedAt",
    candidate.source_message_id AS "sourceMessageId",
    candidate.first_summarized_message_id AS "firstSummarizedMessageId",
    candidate.summary_markdown AS "summaryMarkdown",
    candidate.thread_id AS "threadId",
    candidate.thread_user_id AS "threadUserId",
    candidate.thread_workspace_id AS "threadWorkspaceId",
    candidate.thread_data_workspace_ids AS "threadDataWorkspaceIds"
  FROM due_organizations AS due
  INNER JOIN claimed_organizations AS claimed
    ON claimed.organization_id = due.organization_id
  LEFT JOIN LATERAL (
    SELECT
      compaction.id AS compaction_id,
      compaction.created_at AS compaction_created_at,
      compaction.memory_extraction_attempted_at,
      compaction.last_summarized_message_id AS source_message_id,
      compaction.first_summarized_message_id,
      compaction.summary_markdown,
      thread.id AS thread_id,
      thread.user_id AS thread_user_id,
      thread.workspace_id AS thread_workspace_id,
      thread.data_workspace_ids AS thread_data_workspace_ids
    FROM chat_thread_compactions AS compaction
    INNER JOIN chat_threads AS thread ON thread.id = compaction.thread_id
    WHERE compaction.memory_extraction_organization_id = due.organization_id
      AND compaction.memory_extraction_consent_at = due.memory_extraction_enabled_at
      AND compaction.memory_extracted_at IS NULL
      AND compaction.status = 'active'
      AND compaction.created_at >= due.memory_extraction_enabled_at
    ORDER BY
      compaction.memory_extraction_attempted_at ASC NULLS FIRST,
      compaction.created_at,
      compaction.id
    LIMIT ${MEMORY_EXTRACTION_PER_ORGANIZATION_LIMIT}
  ) AS candidate ON true
  ORDER BY
    due.memory_extraction_scheduled_at,
    due.organization_id,
    candidate.memory_extraction_attempted_at ASC NULLS FIRST,
    candidate.compaction_created_at,
    candidate.compaction_id
`;

type BuildSettleMemoryExtractionQueueQueryOptions = {
  leaseExpiresAt: Date;
  now: Date;
  organizationId: SafeId<"organization">;
};

/**
 * Release one claimed tenant with compare-and-set semantics. A compaction
 * trigger that wakes the tenant while work is in flight changes scheduled_at,
 * causing this stale settlement to no-op instead of erasing the wakeup.
 */
export const buildSettleMemoryExtractionQueueQuery = ({
  leaseExpiresAt,
  now,
  organizationId,
}: BuildSettleMemoryExtractionQueueQueryOptions) => sql`
  UPDATE organization_settings AS settings
  SET memory_extraction_scheduled_at = CASE
    WHEN EXISTS (
      SELECT 1
      FROM chat_thread_compactions AS compaction
      WHERE compaction.memory_extraction_organization_id = settings.organization_id
        AND compaction.memory_extraction_consent_at = settings.memory_extraction_enabled_at
        AND compaction.memory_extracted_at IS NULL
        AND compaction.status = 'active'
        AND compaction.created_at >= settings.memory_extraction_enabled_at
      LIMIT 1
    ) THEN ${now}
    ELSE NULL
  END
  WHERE settings.organization_id = ${organizationId}
    AND settings.memory_extraction_enabled = true
    AND settings.memory_extraction_enabled_at IS NOT NULL
    AND settings.memory_extraction_scheduled_at = ${leaseExpiresAt}
`;

export const groupClaimedMemoryExtractionRows = (
  rows: readonly MemoryExtractionQueueRow[],
): ClaimedMemoryExtractionOrganization[] => {
  const organizations: ClaimedMemoryExtractionOrganization[] = [];
  for (const row of rows) {
    let organization = organizations.at(-1);
    if (organization?.organizationId !== row.organizationId) {
      organization = {
        compactions: [],
        organizationId: row.organizationId,
      };
      organizations.push(organization);
    }

    if (row.compactionId === null) {
      continue;
    }
    organization.compactions.push(toQueuedMemoryCompaction(row));
  }
  return organizations;
};

export const interleaveClaimedMemoryCompactions = (
  organizations: readonly ClaimedMemoryExtractionOrganization[],
): QueuedMemoryCompaction[] => {
  const interleaved: QueuedMemoryCompaction[] = [];
  for (
    let rank = 0;
    rank < MEMORY_EXTRACTION_PER_ORGANIZATION_LIMIT;
    rank += 1
  ) {
    for (const organization of organizations.slice(
      0,
      MEMORY_EXTRACTION_ORGANIZATION_BATCH_SIZE,
    )) {
      const compaction = organization.compactions.at(rank);
      if (compaction) {
        interleaved.push(compaction);
      }
      if (interleaved.length >= MEMORY_EXTRACTION_BATCH_SIZE) {
        return interleaved;
      }
    }
  }
  return interleaved;
};

const toQueuedMemoryCompaction = (
  row: MemoryExtractionQueueRow,
): QueuedMemoryCompaction => {
  if (
    row.compactionId === null ||
    row.compactionCreatedAt === null ||
    row.firstSummarizedMessageId === null ||
    row.sourceMessageId === null ||
    row.summaryMarkdown === null ||
    row.threadDataWorkspaceIds === null ||
    row.threadId === null ||
    row.threadUserId === null
  ) {
    return panic("Claimed memory compaction is missing required thread data");
  }
  return {
    compactionId: row.compactionId,
    compactionCreatedAt: row.compactionCreatedAt,
    firstSummarizedMessageId: row.firstSummarizedMessageId,
    sourceMessageId: row.sourceMessageId,
    summaryMarkdown: row.summaryMarkdown,
    threadDataWorkspaceIds: row.threadDataWorkspaceIds,
    threadId: row.threadId,
    threadOrganizationId: row.organizationId,
    threadUserId: brandPersistedUserId(row.threadUserId),
    threadWorkspaceId: row.threadWorkspaceId,
  };
};
