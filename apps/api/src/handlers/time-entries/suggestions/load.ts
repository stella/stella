import { panic, Result } from "better-result";
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

import { parseTimeEntrySuggestionEvidence } from "@stll/api-contract/time-entries";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  chatMessages,
  chatThreads,
  entities,
  TIME_ENTRY_SOURCE,
  timeEntries,
  timeEntrySuggestions,
} from "@/api/db/schema";
import {
  type ActivitySignal,
  clusterActivitySignals,
  type CoveredSuggestionCluster,
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

type DayBounds = { date: string; start: Date; end: Date };

type DateRange = {
  start: Date;
  end: Date;
  days: number;
  /** Each calendar day of the range with its own bounds in the zone. */
  dayBounds: DayBounds[];
};

const boundsOfDay = (day: Temporal.PlainDate, timezoneId: string) => ({
  date: day.toString(),
  start: new Date(day.toZonedDateTime(timezoneId).epochMilliseconds),
  end: new Date(
    day.add({ days: 1 }).toZonedDateTime(timezoneId).epochMilliseconds,
  ),
});

/**
 * The instants that bound whole calendar days in the timekeeper's zone, from
 * the start of `startDate` to the end of `endDate`. A range runs forwards and
 * spans at most a week, so every read below stays bounded by it.
 */
const dateRangeInTimeZone = (
  startDate: string,
  endDate: string,
  timezoneId: string,
): Result<DateRange, HandlerError<400>> =>
  Result.try({
    try: () => {
      const first = Temporal.PlainDate.from(startDate);
      const last = Temporal.PlainDate.from(endDate);
      const days = first.until(last, { largestUnit: "days" }).days + 1;
      const dayBounds = Array.from(
        { length: Math.min(Math.max(days, 0), LIMITS.timeRangeDaysMax) },
        (_, index) => boundsOfDay(first.add({ days: index }), timezoneId),
      );
      return {
        start: boundsOfDay(first, timezoneId).start,
        end: boundsOfDay(last, timezoneId).end,
        days,
        dayBounds,
      };
    },
    catch: () =>
      new HandlerError({
        status: 400,
        message: "Invalid date or timezone identifier",
      }),
  }).andThen((range) =>
    range.days >= 1 && range.days <= LIMITS.timeRangeDaysMax
      ? Result.ok(range)
      : Result.err(
          new HandlerError({
            status: 400,
            code: "invalid_date_range",
            message: `A suggestion range covers 1 to ${LIMITS.timeRangeDaysMax} days`,
            hint: "Pass an endDate on or after startDate and at most six days later.",
          }),
        ),
  );

export type LoadTimeSuggestionsOptions = {
  featureAccessSnapshot: FeatureAccessSnapshot | undefined;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  date: string;
  timezoneId: string;
};

export type LoadTimeSuggestionRangeOptions = Omit<
  LoadTimeSuggestionsOptions,
  "workspaceId" | "date"
> & {
  /**
   * Matters the caller is already authorized for. Every read is filtered to
   * them: audit rows are only organization-scoped below the database, so this
   * list is what keeps a matter the timekeeper lost access to out.
   */
  workspaceIds: readonly SafeId<"workspace">[];
  startDate: string;
  endDate: string;
};

type LoadedTimeSuggestions = {
  date: string;
  /** Clusters the timekeeper has not accepted or dismissed yet, in time order. */
  pending: CoveredSuggestionCluster[];
  loggedMinutes: number;
};

/** One matter on one day of a range, with work to suggest or time recorded. */
export type LoadedSuggestionScope = LoadedTimeSuggestions & {
  workspaceId: SafeId<"workspace">;
};

const signalIdentityKey = (identity: ActivitySignal["identity"]) =>
  `${identity.source}\n${identity.resourceId}\n${identity.timestamp}`;

// Stored evidence is read as untrusted JSON: a decision whose evidence does not
// parse, or names no signal identities, covers no signals.
const decidedSignalKeys = (storedEvidence: unknown) =>
  Array.isArray(storedEvidence)
    ? storedEvidence.flatMap((item) => {
        const parsed = parseTimeEntrySuggestionEvidence(item);
        return parsed === null ? [] : parsed.signals.map(signalIdentityKey);
      })
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

type SuggestionReadScope = {
  organizationId: SafeId<"organization">;
  workspaceIds: SafeId<"workspace">[];
  userId: SafeId<"user">;
  startDate: string;
  endDate: string;
  /** Range bounds as ISO instants of whole calendar days. */
  rangeStart: string;
  rangeEnd: string;
  /** The zone whose calendar days partition the per-day signal cap. */
  timezoneId: string;
  /**
   * Bound on rows per source: the per-day cap for every matter and day of the
   * range, so it never cuts a matter-day short of its own cap.
   */
  limit: number;
  featureAccessSnapshot: FeatureAccessSnapshot | undefined;
};

type MatterDayRankOptions = {
  id: AnyColumn;
  workspaceId: AnyColumn;
  createdAt: AnyColumn;
  timezoneId: string;
};
// Each matter and calendar day keeps its first signals up to the per-day cap,
// whatever the range, so a week read and a one-day decision reload offer and
// validate the same clusters.
const rankWithinMatterDay = ({
  id,
  workspaceId,
  createdAt,
  timezoneId,
}: MatterDayRankOptions) =>
  sql<number>`row_number() OVER (PARTITION BY ${workspaceId}, (${createdAt} AT TIME ZONE ${timezoneId})::date ORDER BY ${createdAt}, ${id})`;

const chatSignalFilters = (scope: SuggestionReadScope) =>
  and(
    eq(chatMessages.userId, scope.userId),
    inArray(chatMessages.workspaceId, scope.workspaceIds),
    eq(chatMessages.role, "user"),
    sql`${chatMessages.createdAt} >= ${scope.rangeStart}::timestamptz`,
    sql`${chatMessages.createdAt} < ${scope.rangeEnd}::timestamptz`,
  );

const auditSignalFilters = (scope: SuggestionReadScope) =>
  and(
    eq(auditLogs.organizationId, scope.organizationId),
    inArray(auditLogs.workspaceId, scope.workspaceIds),
    eq(auditLogs.userId, scope.userId),
    eq(auditLogs.performerType, "user"),
    notInArray(auditLogs.resourceType, [...EXCLUDED_AUDIT_RESOURCE_TYPES]),
    sql`${auditLogs.createdAt} >= ${scope.rangeStart}::timestamptz`,
    sql`${auditLogs.createdAt} < ${scope.rangeEnd}::timestamptz`,
  );

const cappedChatSignalIds = (tx: Transaction, scope: SuggestionReadScope) => {
  const ranked = tx
    .select({
      id: chatMessages.id,
      rank: rankWithinMatterDay({
        id: chatMessages.id,
        workspaceId: chatMessages.workspaceId,
        createdAt: chatMessages.createdAt,
        timezoneId: scope.timezoneId,
      }).as("signal_rank"),
    })
    .from(chatMessages)
    .where(chatSignalFilters(scope))
    .as("ranked_chat_signals");
  return tx
    .select({ id: ranked.id })
    .from(ranked)
    .where(lte(ranked.rank, LIMITS.timeSuggestionSignalsPerSourceMax));
};

const cappedAuditSignalIds = (tx: Transaction, scope: SuggestionReadScope) => {
  const ranked = tx
    .select({
      id: auditLogs.id,
      rank: rankWithinMatterDay({
        id: auditLogs.id,
        workspaceId: auditLogs.workspaceId,
        createdAt: auditLogs.createdAt,
        timezoneId: scope.timezoneId,
      }).as("signal_rank"),
    })
    .from(auditLogs)
    .where(auditSignalFilters(scope))
    .as("ranked_audit_signals");
  return tx
    .select({ id: ranked.id })
    .from(ranked)
    .where(lte(ranked.rank, LIMITS.timeSuggestionSignalsPerSourceMax));
};

const readChatSignals = async (tx: Transaction, scope: SuggestionReadScope) =>
  await tx
    .select({
      id: chatMessages.id,
      workspaceId: chatMessages.workspaceId,
      threadId: chatMessages.threadId,
      title: chatThreads.title,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .where(
      and(
        chatSignalFilters(scope),
        inArray(chatMessages.id, cappedChatSignalIds(tx, scope)),
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(scope.limit);

const readAuditSignals = async (tx: Transaction, scope: SuggestionReadScope) =>
  await tx
    .select({
      id: auditLogs.id,
      workspaceId: auditLogs.workspaceId,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      action: auditLogs.action,
      metadata: auditLogs.metadata,
      changes: auditReadChangesSql({
        featureAccessSnapshot: scope.featureAccessSnapshot,
        principal: {
          organizationId: scope.organizationId,
          userId: scope.userId,
        },
      }),
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(
      and(
        auditSignalFilters(scope),
        inArray(auditLogs.id, cappedAuditSignalIds(tx, scope)),
      ),
    )
    .orderBy(asc(auditLogs.createdAt), asc(auditLogs.id))
    .limit(scope.limit);

type AuditSignalRow = Awaited<ReturnType<typeof readAuditSignals>>[number];

// Audit rows store resource ids as opaque text; the ids that name a document
// are branded here so the entity lookup stays typed.
const auditResourceEntityIds = (auditRows: readonly AuditSignalRow[]) => {
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
  return resourceEntityIds;
};

const readEntityNames = async (
  tx: Transaction,
  scope: SuggestionReadScope,
  entityIds: SafeId<"entity">[],
) => {
  if (entityIds.length === 0) {
    return new Map<SafeId<"entity">, string>();
  }
  const rows = await tx
    .select({ id: entities.id, name: entities.displayName })
    .from(entities)
    .where(
      and(
        inArray(entities.workspaceId, scope.workspaceIds),
        inArray(entities.id, entityIds),
      ),
    );
  return new Map(rows.map((row) => [row.id, row.name]));
};

const readDecidedEvidence = async (
  tx: Transaction,
  scope: SuggestionReadScope,
) =>
  await tx
    .select({
      workspaceId: timeEntrySuggestions.workspaceId,
      dateWorked: timeEntrySuggestions.dateWorked,
      fingerprint: timeEntrySuggestions.fingerprint,
      evidence: timeEntrySuggestions.evidence,
    })
    .from(timeEntrySuggestions)
    .where(
      and(
        inArray(timeEntrySuggestions.workspaceId, scope.workspaceIds),
        eq(timeEntrySuggestions.userId, scope.userId),
        gte(timeEntrySuggestions.dateWorked, scope.startDate),
        lte(timeEntrySuggestions.dateWorked, scope.endDate),
      ),
    );

// The timekeeper's time booked to the range, plus timed entries booked to
// another day whose clock overlaps it: a timer booked to the day before the
// range still covers the first day's activity past midnight.
const readRecordedTime = async (tx: Transaction, scope: SuggestionReadScope) =>
  await tx
    .select({
      workspaceId: timeEntries.workspaceId,
      dateWorked: timeEntries.dateWorked,
      source: timeEntries.source,
      durationMinutes: timeEntries.durationMinutes,
      startedAt: timeEntries.timerStartedAt,
      endedAt: timeEntries.timerStoppedAt,
    })
    .from(timeEntries)
    .where(
      and(
        inArray(timeEntries.workspaceId, scope.workspaceIds),
        eq(timeEntries.userId, scope.userId),
        or(
          and(
            gte(timeEntries.dateWorked, scope.startDate),
            lte(timeEntries.dateWorked, scope.endDate),
          ),
          and(
            sql`${timeEntries.timerStartedAt} < ${scope.rangeEnd}::timestamptz`,
            sql`${timeEntries.timerStoppedAt} > ${scope.rangeStart}::timestamptz`,
          ),
        ),
      ),
    );

type RecordedRow = Awaited<ReturnType<typeof readRecordedTime>>[number];

/**
 * The range's days a recorded entry bears on: the day it is booked to, and
 * every day its timer's clock overlaps.
 */
const daysCoveredBy = (row: RecordedRow, dayBounds: readonly DayBounds[]) =>
  dayBounds
    .filter(
      ({ date, start, end }) =>
        row.dateWorked === date ||
        (row.startedAt !== null &&
          row.endedAt !== null &&
          row.startedAt < end &&
          row.endedAt > start),
    )
    .map(({ date }) => date);

// The day's logged time counts only entries booked to it; a timer booked to
// the previous day that ran past midnight covers activity but is not logged here.
const loggedMinutesOn = (date: string, recorded: readonly RecordedRow[]) => {
  let minutes = 0;
  for (const entry of recorded) {
    if (entry.dateWorked === date) {
      minutes += entry.durationMinutes;
    }
  }
  return minutes;
};

// An accepted suggestion's entry paid for exactly the signals its decision
// covers, which are already excluded before clustering; counting its minutes
// again would mark unrelated activity as covered.
const recordedOutsideSuggestions = (recorded: readonly RecordedRow[]) =>
  recorded.filter(({ source }) => source !== TIME_ENTRY_SOURCE.SUGGESTED);

// One transaction for every read: the signals, the names behind them, the
// decisions already taken, and the time already recorded. Each source is one
// statement for the whole range and every matter, never one per matter or day.
const readSuggestionInputs = async (
  tx: Transaction,
  scope: SuggestionReadScope,
) => {
  const chatRows = await readChatSignals(tx, scope);
  const auditRows = await readAuditSignals(tx, scope);
  const resourceEntityIds = auditResourceEntityIds(auditRows);
  const entityNames = await readEntityNames(tx, scope, [
    ...new Set(resourceEntityIds.values()),
  ]);
  const decidedRows = await readDecidedEvidence(tx, scope);
  const recordedRows = await readRecordedTime(tx, scope);
  return {
    auditRows,
    chatRows,
    decidedRows,
    entityNames,
    resourceEntityIds,
    recordedRows,
  };
};

type SuggestionInputs = Awaited<ReturnType<typeof readSuggestionInputs>>;

type DatedSignal = {
  workspaceId: SafeId<"workspace"> | null;
  signal: ActivitySignal;
};

const toActivitySignals = ({
  auditRows,
  chatRows,
  entityNames,
  resourceEntityIds,
}: SuggestionInputs): DatedSignal[] => [
  ...chatRows.map((row) => ({
    workspaceId: row.workspaceId,
    signal: {
      at: row.createdAt,
      key: `chat:${row.id}`,
      identity: {
        source: "chat_message" as const,
        resourceId: row.id,
        timestamp: row.createdAt.toISOString(),
      },
      evidence: {
        type: "chat_thread" as const,
        id: row.threadId,
        title: row.title,
      },
    },
  })),
  ...auditRows.map((row) => {
    const entityId = resourceEntityIds.get(row.id);
    return {
      workspaceId: row.workspaceId,
      signal: {
        at: row.createdAt,
        key: `audit:${row.id}`,
        identity: {
          source: "audit_log" as const,
          resourceId: row.id,
          timestamp: row.createdAt.toISOString(),
        },
        evidence: entityId
          ? {
              type: "resource" as const,
              id: entityId,
              resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
              name: entityNames.get(entityId) ?? null,
              action: row.action,
            }
          : {
              type: "resource" as const,
              id: row.resourceId,
              resourceType: row.resourceType,
              name: null,
              action: row.action,
            },
      },
    };
  }),
];

type ScopeInputs = {
  workspaceId: SafeId<"workspace">;
  date: string;
  signals: ActivitySignal[];
  recorded: RecordedRow[];
};

const decidedFingerprintKey = (
  workspaceId: SafeId<"workspace">,
  date: string,
  fingerprint: string,
) => `${workspaceId}\n${date}\n${fingerprint}`;

/**
 * Buckets signals and recorded time by matter and by the calendar day they
 * fall on in the timekeeper's zone. A row for a matter outside the authorized
 * list cannot be bucketed: the reads filter on that list, so reaching one
 * means the filter was lost, and the request fails instead of leaking it.
 */
const groupByMatterAndDay = ({
  workspaceIds,
  timezoneId,
  dayBounds,
  signals,
  recordedRows,
}: {
  workspaceIds: readonly SafeId<"workspace">[];
  timezoneId: string;
  dayBounds: readonly DayBounds[];
  signals: readonly DatedSignal[];
  recordedRows: readonly RecordedRow[];
}) => {
  const authorized = new Set<string>(workspaceIds);
  const scopes = new Map<string, ScopeInputs>();
  const scopeFor = (
    workspaceId: SafeId<"workspace"> | null,
    date: string,
  ): ScopeInputs => {
    if (workspaceId === null || !authorized.has(workspaceId)) {
      return panic("Suggestion input escaped the authorized matters");
    }
    const key = `${date}\n${workspaceId}`;
    const existing = scopes.get(key);
    if (existing) {
      return existing;
    }
    const created: ScopeInputs = {
      workspaceId,
      date,
      signals: [],
      recorded: [],
    };
    scopes.set(key, created);
    return created;
  };
  for (const { workspaceId, signal } of signals) {
    const date = Temporal.Instant.fromEpochMilliseconds(signal.at.getTime())
      .toZonedDateTimeISO(timezoneId)
      .toPlainDate()
      .toString();
    scopeFor(workspaceId, date).signals.push(signal);
  }
  for (const row of recordedRows) {
    for (const date of daysCoveredBy(row, dayBounds)) {
      scopeFor(row.workspaceId, date).recorded.push(row);
    }
  }
  return [...scopes.values()];
};

/**
 * Clusters one matter's day and drops what is already settled: time recorded
 * over a cluster's window, and any cluster whose fingerprint was decided. A
 * fingerprint is a decision's idempotency key: once decided, a suggestion with
 * that fingerprint can never be resolved again, so it is never pending, even
 * when its decision's evidence names no signals to exclude.
 */
const suggestScope = (
  { workspaceId, date, signals, recorded }: ScopeInputs,
  decidedFingerprints: ReadonlySet<string>,
): LoadedSuggestionScope => {
  const clusters = clusterActivitySignals({
    date,
    signals,
    mergeGapMinutes: LIMITS.timeSuggestionMergeGapMinutes,
    tailMinutes: LIMITS.timeSuggestionTailMinutes,
  });
  return {
    workspaceId,
    date,
    pending: subtractRecordedTime(
      clusters.filter(
        ({ fingerprint }) =>
          !decidedFingerprints.has(
            decidedFingerprintKey(workspaceId, date, fingerprint),
          ),
      ),
      recordedOutsideSuggestions(recorded),
    ),
    loggedMinutes: loggedMinutesOn(date, recorded),
  };
};

// Dates and ids are compared as code points: both are fixed-format keys, and
// the order only has to be stable, never linguistic.
const compareKeys = (a: string, b: string) => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const compareScopes = (a: LoadedSuggestionScope, b: LoadedSuggestionScope) =>
  compareKeys(a.date, b.date) || compareKeys(a.workspaceId, b.workspaceId);

/**
 * Recomputes suggested entries for every authorized matter and every day of a
 * range (at most a week) from the timekeeper's own signals: the chat messages
 * they sent and the audit rows their actions wrote. Nothing here is visible to
 * anyone but the signal's author, and the result is never persisted; only a
 * decision on a cluster is. Scopes come back in date, then matter order, and
 * only for a matter and day that has activity or recorded time.
 * @yields A 400 for an invalid or over-long range, or the scoped read's failure.
 */
export const loadTimeSuggestionRange = async function* ({
  safeDb,
  organizationId,
  workspaceIds,
  userId,
  startDate,
  endDate,
  timezoneId,
  featureAccessSnapshot,
}: LoadTimeSuggestionRangeOptions) {
  const range = yield* dateRangeInTimeZone(startDate, endDate, timezoneId);
  if (workspaceIds.length === 0) {
    const none: LoadedSuggestionScope[] = [];
    return none;
  }
  const scope: SuggestionReadScope = {
    organizationId,
    workspaceIds: [...workspaceIds],
    userId,
    startDate,
    endDate,
    // Range bounds are whole seconds computed from the calendar, never read
    // back from a timestamp column, so the cast keeps the comparison at
    // column precision without a cursor codec.
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    timezoneId,
    limit:
      LIMITS.timeSuggestionSignalsPerSourceMax *
      range.days *
      workspaceIds.length,
    featureAccessSnapshot,
  };
  const inputs = yield* Result.await(
    safeDb(async (tx) => await readSuggestionInputs(tx, scope)),
  );
  const signals = toActivitySignals(inputs);
  const decidedFingerprints = new Set(
    inputs.decidedRows.map((row) =>
      decidedFingerprintKey(row.workspaceId, row.dateWorked, row.fingerprint),
    ),
  );
  const undecidedSignals = new Set(
    excludeDecidedSignals(
      signals.map(({ signal }) => signal),
      inputs.decidedRows.map(({ evidence }) => evidence),
    ),
  );
  return groupByMatterAndDay({
    workspaceIds,
    timezoneId,
    dayBounds: range.dayBounds,
    signals: signals.filter(({ signal }) => undecidedSignals.has(signal)),
    recordedRows: inputs.recordedRows,
  })
    .map((scopeInputs) => suggestScope(scopeInputs, decidedFingerprints))
    .toSorted(compareScopes);
};

/**
 * The one-matter, one-day view of {@link loadTimeSuggestionRange}, for a
 * matter the handler already authorized.
 * @yields A 400 for an invalid date or zone, or the scoped read's failure.
 */
export const loadTimeSuggestions = async function* ({
  workspaceId,
  date,
  ...options
}: LoadTimeSuggestionsOptions) {
  const scopes = yield* loadTimeSuggestionRange({
    ...options,
    workspaceIds: [workspaceId],
    startDate: date,
    endDate: date,
  });
  const scope = scopes.at(0);
  const loaded: LoadedTimeSuggestions =
    scope === undefined
      ? { date, pending: [], loggedMinutes: 0 }
      : { date, pending: scope.pending, loggedMinutes: scope.loggedMinutes };
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
