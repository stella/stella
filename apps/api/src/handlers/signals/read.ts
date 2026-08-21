import { Result } from "better-result";
import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { SIGNAL_STATUS } from "@stll/api-contract/signals";
import type { SignalOrigin, SignalSeverity } from "@stll/api-contract/signals";

import type { SafeDb } from "@/api/db/safe-db";
import { signals, workspaces } from "@/api/db/schema";
import type { SignalView } from "@/api/handlers/signals/schema";
import { SIGNAL_VIEW } from "@/api/handlers/signals/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
} from "@/api/lib/pagination";
import { brandPersistedSignalId } from "@/api/lib/safe-id-boundaries";

/**
 * Visibility: a scoped signal is visible when its workspace is visible
 * (the `workspaces` table is RLS-filtered to the caller's membership, so
 * the correlated EXISTS is the authorization); an unscoped one only to
 * members holding the triage permission.
 */
export const signalVisibilityCondition = (canTriage: boolean): SQL => {
  const scopedVisible = sql`exists (select 1 from ${workspaces} w where w.id = ${signals.workspaceId})`;
  if (!canTriage) {
    return scopedVisible;
  }
  return sql`(${isNull(signals.workspaceId)} or ${scopedVisible})`;
};

const viewCondition = (view: SignalView, now: Date): SQL | undefined => {
  switch (view) {
    case SIGNAL_VIEW.OPEN:
      return or(
        eq(signals.status, SIGNAL_STATUS.NEW),
        and(
          eq(signals.status, SIGNAL_STATUS.SNOOZED),
          lte(signals.snoozedUntil, now),
        ),
      );
    case SIGNAL_VIEW.SNOOZED:
      return and(
        eq(signals.status, SIGNAL_STATUS.SNOOZED),
        sql`${signals.snoozedUntil} > ${now}`,
      );
    case SIGNAL_VIEW.RESOLVED:
      return or(
        eq(signals.status, SIGNAL_STATUS.ACCEPTED),
        eq(signals.status, SIGNAL_STATUS.DISMISSED),
      );
    default: {
      const exhaustive: never = view;
      return exhaustive;
    }
  }
};

const decodeSignalCursor = (cursor: string): SafeId<"signal"> | null => {
  const parts = decodePaginationCursor(cursor);
  if (!parts || parts.length !== 1) {
    return null;
  }
  const [rawId] = parts;
  if (!isUuidPaginationCursorPart(rawId)) {
    return null;
  }
  return brandPersistedSignalId(rawId);
};

const signalColumns = {
  id: signals.id,
  workspaceId: signals.workspaceId,
  kind: signals.kind,
  origin: signals.origin,
  scoutKey: signals.scoutKey,
  severity: signals.severity,
  confidence: signals.confidence,
  title: signals.title,
  summary: signals.summary,
  subject: signals.subject,
  evidence: signals.evidence,
  suggestions: signals.suggestions,
  status: signals.status,
  snoozedUntil: signals.snoozedUntil,
  assigneeUserId: signals.assigneeUserId,
  createdByUserId: signals.createdByUserId,
  dismissReason: signals.dismissReason,
  acceptedResult: signals.acceptedResult,
  resolvedAt: signals.resolvedAt,
  createdAt: signals.createdAt,
  updatedAt: signals.updatedAt,
};

type SignalRow = Omit<
  typeof signals.$inferSelect,
  "organizationId" | "dedupeKey"
>;

export const serializeSignal = (row: SignalRow) => ({
  ...row,
  snoozedUntil: row.snoozedUntil?.toISOString() ?? null,
  resolvedAt: row.resolvedAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

type ListSignalsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  canTriage: boolean;
  /** Already validated through `getWorkspaceAccess`; null = no filter. */
  workspaceFilter: SafeId<"workspace"> | null;
  query: {
    view?: SignalView;
    origin?: SignalOrigin;
    severity?: SignalSeverity;
    assignedToMe?: boolean;
    limit?: number;
    cursor?: string;
  };
};

export const listSignalsHandler = async function* ({
  safeDb,
  organizationId,
  userId,
  canTriage,
  workspaceFilter,
  query,
}: ListSignalsProps) {
  const limit = query.limit ?? LIMITS.signalsPageSizeDefault;
  const now = new Date();
  const conditions: (SQL | undefined)[] = [
    eq(signals.organizationId, organizationId),
    signalVisibilityCondition(canTriage),
    viewCondition(query.view ?? SIGNAL_VIEW.OPEN, now),
  ];
  if (workspaceFilter) {
    conditions.push(eq(signals.workspaceId, workspaceFilter));
  }
  if (query.origin) {
    conditions.push(eq(signals.origin, query.origin));
  }
  if (query.severity) {
    conditions.push(eq(signals.severity, query.severity));
  }
  if (query.assignedToMe) {
    conditions.push(eq(signals.assigneeUserId, userId));
  }

  if (query.cursor) {
    const cursor = decodeSignalCursor(query.cursor);
    if (!cursor) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    const boundary = yield* Result.await(
      safeDb((tx) =>
        tx.query.signals.findFirst({
          where: { id: { eq: cursor }, organizationId: { eq: organizationId } },
          columns: { id: true },
        }),
      ),
    );
    if (!boundary) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    conditions.push(
      sql`(${signals.createdAt}, ${signals.id}) < (select b.created_at, b.id from signals b where b.id = ${cursor} and b.organization_id = ${organizationId})`,
    );
  }

  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select(signalColumns)
        .from(signals)
        .where(and(...conditions))
        .orderBy(desc(signals.createdAt), desc(signals.id))
        .limit(limit + 1),
    ),
  );

  const page = createCursorPage({
    rows,
    limit,
    cursorForItem: (item) => encodePaginationCursor([item.id]),
  });
  return Result.ok({ ...page, items: page.items.map(serializeSignal) });
};

type GetSignalProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  canTriage: boolean;
  signalId: SafeId<"signal">;
};

/**
 * Loads one visible signal or 404s; shared by get and every transition.
 * @yields the safeDb read
 */
export const loadVisibleSignal = async function* ({
  safeDb,
  organizationId,
  canTriage,
  signalId,
}: GetSignalProps) {
  const rows = yield* Result.await(
    safeDb((tx) =>
      tx
        .select(signalColumns)
        .from(signals)
        .where(
          and(
            eq(signals.id, signalId),
            eq(signals.organizationId, organizationId),
            signalVisibilityCondition(canTriage),
          ),
        )
        .limit(1),
    ),
  );
  const row = rows.at(0);
  if (!row) {
    return Result.err(
      new HandlerError({ status: 404, message: "Signal not found" }),
    );
  }
  return Result.ok(row);
};

export const openSignalCountHandler = async function* ({
  safeDb,
  organizationId,
  canTriage,
}: Omit<GetSignalProps, "signalId">) {
  const count = yield* Result.await(
    safeDb((tx) =>
      tx.$count(
        signals,
        and(
          eq(signals.organizationId, organizationId),
          signalVisibilityCondition(canTriage),
          viewCondition(SIGNAL_VIEW.OPEN, new Date()),
        ),
      ),
    ),
  );
  return Result.ok({ count });
};
