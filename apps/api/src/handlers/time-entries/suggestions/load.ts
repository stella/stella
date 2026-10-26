import { Result } from "better-result";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";

import { parseTimeEntrySuggestionEvidence } from "@stll/api-contract/time-entries";
import { Temporal } from "@stll/time";

import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  chatMessages,
  chatThreads,
  entities,
  timeEntries,
  timeEntrySuggestions,
} from "@/api/db/schema";
import {
  type ActivitySignal,
  clusterActivitySignals,
  subtractRecordedTime,
  type SuggestionCluster,
} from "@/api/handlers/time-entries/suggestions/cluster";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditResourceType } from "@/api/lib/audit-log";
import { auditReadChangesSql } from "@/api/lib/audit-log-details";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";

/**
 * Audit rows that are bookkeeping about billing or the platform itself, not
 * matter work. Logging time must never read as more activity to suggest.
 */
const EXCLUDED_AUDIT_RESOURCE_TYPES = [
  AUDIT_RESOURCE_TYPE.AUDIT_LOG,
  AUDIT_RESOURCE_TYPE.TIME_ENTRY,
  AUDIT_RESOURCE_TYPE.INVOICE,
  AUDIT_RESOURCE_TYPE.EXPENSE,
  AUDIT_RESOURCE_TYPE.BILLING_CODE,
  AUDIT_RESOURCE_TYPE.RATE_ENTRY,
  AUDIT_RESOURCE_TYPE.RATE_TABLE,
  AUDIT_RESOURCE_TYPE.USAGE_ALLOCATION,
  AUDIT_RESOURCE_TYPE.USAGE_ENTITLEMENT,
  AUDIT_RESOURCE_TYPE.USAGE_EVENT,
  AUDIT_RESOURCE_TYPE.CHAT_FILE,
  AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
  AUDIT_RESOURCE_TYPE.CHAT_THREAD,
  AUDIT_RESOURCE_TYPE.CHAT_TOOL_EXECUTION,
  AUDIT_RESOURCE_TYPE.AI_MEMORY,
  AUDIT_RESOURCE_TYPE.ANNOUNCEMENT,
  AUDIT_RESOURCE_TYPE.MACHINE_API_KEY,
  AUDIT_RESOURCE_TYPE.MCP_CONNECTION,
  AUDIT_RESOURCE_TYPE.MCP_GATEWAY_TOOL,
  AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
  AUDIT_RESOURCE_TYPE.SIGNAL,
] as const satisfies readonly AuditResourceType[];

/**
 * Audit rows about a part of a document carry the owning document id in
 * their payload. Folding them onto the document keeps one evidence line per
 * document instead of one per version, field, or desktop session.
 */
const ENTITY_SCOPED_AUDIT_RESOURCE_TYPES = new Set<string>([
  AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
  AUDIT_RESOURCE_TYPE.FIELD,
  AUDIT_RESOURCE_TYPE.DESKTOP_EDIT_SESSION,
  AUDIT_RESOURCE_TYPE.FOLIO_COLLAB_ROOM,
]);

const isRecord = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null;

const payloadEntityId = (
  metadata: Record<string, unknown> | null,
  changes: Record<string, unknown> | null,
): string | null => {
  if (typeof metadata?.["entityId"] === "string") {
    return metadata["entityId"];
  }
  const created = changes?.["created"];
  const createdNew = isRecord(created) ? created["new"] : null;
  return isRecord(createdNew) && typeof createdNew["entityId"] === "string"
    ? createdNew["entityId"]
    : null;
};

type DayRange = { start: Date; end: Date };

const dayRangeInTimeZone = (
  date: string,
  timezoneId: string,
): Result<DayRange, HandlerError<400>> =>
  Result.try({
    try: () => {
      const day = Temporal.PlainDate.from(date);
      return {
        start: new Date(day.toZonedDateTime(timezoneId).epochMilliseconds),
        end: new Date(
          day.add({ days: 1 }).toZonedDateTime(timezoneId).epochMilliseconds,
        ),
      };
    },
    catch: () =>
      new HandlerError({
        status: 400,
        message: "Invalid date or timezone identifier",
      }),
  });

export type LoadTimeSuggestionsOptions = {
  featureAccessSnapshot: FeatureAccessSnapshot | undefined;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  date: string;
  timezoneId: string;
};

type LoadedTimeSuggestions = {
  date: string;
  /** Clusters the timekeeper has not accepted or dismissed yet, in time order. */
  pending: (SuggestionCluster & { alreadyCovered: boolean })[];
  loggedMinutes: number;
};

const signalIdentityKey = (identity: ActivitySignal["identity"]) =>
  `${identity.source}\n${identity.resourceId}\n${identity.timestamp}`;

// Stored evidence is read as untrusted JSON: a decision whose evidence does not
// parse, or names no signal identities, covers no signals.
const decidedSignalKeys = (storedEvidence: unknown) =>
  Array.isArray(storedEvidence)
    ? storedEvidence.flatMap(
        (item) =>
          parseTimeEntrySuggestionEvidence(item)?.signals.map(
            signalIdentityKey,
          ) ?? [],
      )
    : [];

const excludeDecidedSignals = (
  signals: readonly ActivitySignal[],
  decidedEvidence: readonly unknown[],
) => {
  const coveredSignalKeys = new Set(decidedEvidence.flatMap(decidedSignalKeys));
  return signals.filter(
    ({ identity }) => !coveredSignalKeys.has(signalIdentityKey(identity)),
  );
};

// Recomputes the day's suggested entries from the timekeeper's own signals in
// this matter: the chat messages they sent and the audit rows their actions
// wrote. Nothing here is visible to anyone but the signal's author, and the
// result is never persisted; only a decision on a cluster is.
export const loadTimeSuggestions = async function* ({
  safeDb,
  organizationId,
  workspaceId,
  userId,
  date,
  timezoneId,
  featureAccessSnapshot,
}: LoadTimeSuggestionsOptions) {
  const range = yield* dayRangeInTimeZone(date, timezoneId);
  const limit = LIMITS.timeSuggestionSignalsPerSourceMax;
  // Day bounds are whole seconds computed from the calendar, never read back
  // from a timestamp column, so the cast keeps the comparison at column
  // precision without a cursor codec.
  const dayStart = sql`${range.start.toISOString()}::timestamptz`;
  const dayEnd = sql`${range.end.toISOString()}::timestamptz`;

  // One transaction for every read: the signals, the names behind them, and
  // the decisions already taken, so a day costs one round-trip set.
  const reads = yield* Result.await(
    safeDb(async (tx) => {
      const chatRows = await tx
        .select({
          id: chatMessages.id,
          threadId: chatMessages.threadId,
          title: chatThreads.title,
          createdAt: chatMessages.createdAt,
        })
        .from(chatMessages)
        .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
        .where(
          and(
            eq(chatMessages.userId, userId),
            eq(chatMessages.workspaceId, workspaceId),
            eq(chatMessages.role, "user"),
            sql`${chatMessages.createdAt} >= ${dayStart}`,
            sql`${chatMessages.createdAt} < ${dayEnd}`,
          ),
        )
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
        .limit(limit);

      const auditRows = await tx
        .select({
          id: auditLogs.id,
          resourceType: auditLogs.resourceType,
          resourceId: auditLogs.resourceId,
          action: auditLogs.action,
          metadata: auditLogs.metadata,
          changes: auditReadChangesSql({
            featureAccessSnapshot,
            principal: { organizationId, userId },
          }),
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.organizationId, organizationId),
            eq(auditLogs.workspaceId, workspaceId),
            eq(auditLogs.userId, userId),
            eq(auditLogs.performerType, "user"),
            notInArray(auditLogs.resourceType, [
              ...EXCLUDED_AUDIT_RESOURCE_TYPES,
            ]),
            sql`${auditLogs.createdAt} >= ${dayStart}`,
            sql`${auditLogs.createdAt} < ${dayEnd}`,
          ),
        )
        .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
        .limit(limit);

      // Audit rows store resource ids as opaque text; the ids that name a
      // document are branded here so the entity lookup stays typed.
      const resourceEntityIds = new Map<string, SafeId<"entity">>();
      for (const row of auditRows) {
        if (row.resourceType === AUDIT_RESOURCE_TYPE.ENTITY) {
          resourceEntityIds.set(row.id, brandPersistedEntityId(row.resourceId));
          continue;
        }
        if (!ENTITY_SCOPED_AUDIT_RESOURCE_TYPES.has(row.resourceType)) {
          continue;
        }
        const entityId = payloadEntityId(row.metadata, row.changes);
        if (entityId) {
          resourceEntityIds.set(row.id, brandPersistedEntityId(entityId));
        }
      }

      const entityIds = [...new Set(resourceEntityIds.values())];
      const entityRows =
        entityIds.length > 0
          ? await tx
              .select({ id: entities.id, name: entities.displayName })
              .from(entities)
              .where(
                and(
                  eq(entities.workspaceId, workspaceId),
                  inArray(entities.id, entityIds),
                ),
              )
          : [];

      const decidedRows = await tx
        .select({ evidence: timeEntrySuggestions.evidence })
        .from(timeEntrySuggestions)
        .where(
          and(
            eq(timeEntrySuggestions.workspaceId, workspaceId),
            eq(timeEntrySuggestions.userId, userId),
            eq(timeEntrySuggestions.dateWorked, date),
          ),
        );

      const recordedRows = await tx
        .select({
          durationMinutes: timeEntries.durationMinutes,
          startedAt: timeEntries.timerStartedAt,
          endedAt: timeEntries.timerStoppedAt,
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.workspaceId, workspaceId),
            eq(timeEntries.userId, userId),
            eq(timeEntries.dateWorked, date),
          ),
        );

      return {
        auditRows,
        chatRows,
        decidedRows,
        entityNames: new Map(entityRows.map((row) => [row.id, row.name])),
        resourceEntityIds,
        recordedRows,
      };
    }),
  );
  const {
    auditRows,
    chatRows,
    decidedRows,
    entityNames,
    resourceEntityIds,
    recordedRows,
  } = reads;

  const signals: ActivitySignal[] = [];
  for (const row of chatRows) {
    signals.push({
      at: row.createdAt,
      key: `chat:${row.id}`,
      identity: {
        source: "chat_message",
        resourceId: row.id,
        timestamp: row.createdAt.toISOString(),
      },
      evidence: { type: "chat_thread", id: row.threadId, title: row.title },
    });
  }
  for (const row of auditRows) {
    const entityId = resourceEntityIds.get(row.id);
    signals.push({
      at: row.createdAt,
      key: `audit:${row.id}`,
      identity: {
        source: "audit_log",
        resourceId: row.id,
        timestamp: row.createdAt.toISOString(),
      },
      evidence: entityId
        ? {
            type: "resource",
            id: entityId,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            name: entityNames.get(entityId) ?? null,
            action: row.action,
          }
        : {
            type: "resource",
            id: row.resourceId,
            resourceType: row.resourceType,
            name: null,
            action: row.action,
          },
    });
  }

  const uncoveredSignals = excludeDecidedSignals(
    signals,
    decidedRows.map(({ evidence }) => evidence),
  );
  const clusters = clusterActivitySignals({
    date,
    signals: uncoveredSignals,
    mergeGapMinutes: LIMITS.timeSuggestionMergeGapMinutes,
    tailMinutes: LIMITS.timeSuggestionTailMinutes,
  });

  const uncovered = subtractRecordedTime(clusters, recordedRows);

  const loaded: LoadedTimeSuggestions = {
    date,
    pending: uncovered,
    loggedMinutes: recordedRows.reduce(
      (sum, entry) => sum + entry.durationMinutes,
      0,
    ),
  };
  return loaded;
};

export const serializeSuggestion = (
  cluster: SuggestionCluster & { alreadyCovered: boolean },
  minimumUnitMinutes: number,
  billableByDefault: boolean,
) => ({
  fingerprint: cluster.fingerprint,
  startedAt: cluster.startedAt.toISOString(),
  endedAt: cluster.endedAt.toISOString(),
  durationMinutes:
    Math.ceil(cluster.durationMinutes / minimumUnitMinutes) *
    minimumUnitMinutes,
  engagedMinutes: cluster.durationMinutes,
  alreadyCovered: cluster.alreadyCovered,
  billableByDefault,
  signalCount: cluster.signalCount,
  evidence: cluster.evidence,
});
