import { panic } from "better-result";
import { sql } from "drizzle-orm";

import type { SafeId, SafeIdType } from "@/api/lib/branded-types";
import {
  brandPersistedChatMessageId,
  brandPersistedChatThreadCompactionId,
  brandPersistedChatThreadId,
  brandPersistedOrganizationId,
  brandPersistedUserId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

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
      AND settings.memory_extraction_scheduled_at <= ${now}::timestamptz
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
    candidate.memory_extraction_data_workspace_ids AS "threadDataWorkspaceIds"
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
      compaction.memory_extraction_data_workspace_ids
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
  organizationIds: readonly SafeId<"organization">[];
};

/**
 * Release every claimed tenant of one pass with compare-and-set semantics. A
 * compaction trigger that wakes a tenant while work is in flight changes its
 * scheduled_at, causing this stale settlement to no-op for that tenant instead
 * of erasing the wakeup; the CAS is per row, so one statement settles the whole
 * batch without any tenant borrowing another's outcome.
 *
 * The ids go in as a single array parameter rather than a list of binds, so the
 * statement's shape does not change with the batch size. `sql.param` is
 * load-bearing: a bare array is expanded into one bind per element, which would
 * put the cast on the last one alone.
 */
export const buildSettleMemoryExtractionQueueQuery = ({
  leaseExpiresAt,
  now,
  organizationIds,
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
  WHERE settings.organization_id = ANY(${sql.param([...organizationIds])}::text[])
    AND settings.memory_extraction_enabled = true
    AND settings.memory_extraction_enabled_at IS NOT NULL
    AND settings.memory_extraction_scheduled_at = ${leaseExpiresAt}::timestamptz
`;

export const groupClaimedMemoryExtractionRows = (
  rows: readonly unknown[],
): ClaimedMemoryExtractionOrganization[] => {
  const organizations: ClaimedMemoryExtractionOrganization[] = [];
  for (const rawRow of rows) {
    const row = parseMemoryExtractionQueueRow(rawRow);
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

const optionalString = (value: unknown): string | null => {
  if (value === null || typeof value === "string") {
    return value;
  }
  return panic("Memory extraction queue returned an invalid string field");
};

const optionalDate = (value: unknown): Date | null => {
  if (value === null || value instanceof Date) {
    return value;
  }
  return panic("Memory extraction queue returned an invalid date field");
};

const optionalSafeId = <T extends SafeIdType>(
  value: unknown,
  brand: (id: string) => SafeId<T>,
): SafeId<T> | null => {
  const id = optionalString(value);
  return id === null ? null : brand(id);
};

const parseMemoryExtractionQueueRow = (
  value: unknown,
): MemoryExtractionQueueRow => {
  if (typeof value !== "object" || value === null) {
    return panic("Memory extraction queue returned an invalid row");
  }

  const organizationId =
    "organizationId" in value ? value.organizationId : undefined;
  const queueScheduledAt =
    "queueScheduledAt" in value ? value.queueScheduledAt : undefined;
  if (
    typeof organizationId !== "string" ||
    !(queueScheduledAt instanceof Date)
  ) {
    return panic("Memory extraction queue returned invalid tenant metadata");
  }

  const dataWorkspaceIds =
    "threadDataWorkspaceIds" in value
      ? value.threadDataWorkspaceIds
      : undefined;
  if (
    dataWorkspaceIds !== null &&
    (!Array.isArray(dataWorkspaceIds) ||
      !dataWorkspaceIds.every((id) => typeof id === "string"))
  ) {
    return panic("Memory extraction queue returned invalid workspace ids");
  }

  return {
    compactionCreatedAt: optionalDate(
      "compactionCreatedAt" in value ? value.compactionCreatedAt : undefined,
    ),
    compactionId: optionalSafeId(
      "compactionId" in value ? value.compactionId : undefined,
      brandPersistedChatThreadCompactionId,
    ),
    firstSummarizedMessageId: optionalSafeId(
      "firstSummarizedMessageId" in value
        ? value.firstSummarizedMessageId
        : undefined,
      brandPersistedChatMessageId,
    ),
    organizationId: brandPersistedOrganizationId(organizationId),
    queueScheduledAt,
    sourceMessageId: optionalSafeId(
      "sourceMessageId" in value ? value.sourceMessageId : undefined,
      brandPersistedChatMessageId,
    ),
    summaryMarkdown: optionalString(
      "summaryMarkdown" in value ? value.summaryMarkdown : undefined,
    ),
    threadDataWorkspaceIds:
      dataWorkspaceIds === null
        ? null
        : dataWorkspaceIds.map(brandPersistedWorkspaceId),
    threadId: optionalSafeId(
      "threadId" in value ? value.threadId : undefined,
      brandPersistedChatThreadId,
    ),
    threadUserId: optionalString(
      "threadUserId" in value ? value.threadUserId : undefined,
    ),
    threadWorkspaceId: optionalSafeId(
      "threadWorkspaceId" in value ? value.threadWorkspaceId : undefined,
      brandPersistedWorkspaceId,
    ),
  };
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
