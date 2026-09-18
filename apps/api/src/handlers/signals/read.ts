import { panic, Result } from "better-result";
import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { SIGNAL_STATUS, SIGNAL_VIEW } from "@stll/api-contract/signals";
import type {
  SignalOrigin,
  SignalSeverity,
  SignalView,
} from "@stll/api-contract/signals";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { signals, workspaces } from "@/api/db/schema";
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
      view satisfies never;
      return panic(`Unhandled view: ${String(view)}`);
    }
  }
};

type SignalListAccessOptions = {
  organizationId: SafeId<"organization">;
  canTriage: boolean;
  view: SignalView;
  now: Date;
};

/**
 * The access and lifecycle predicate every signal list shares: the caller's
 * organization, the visibility rule, and the requested view. The Inbox
 * window composes the same conditions into its union, so a signal is listed
 * there exactly when this endpoint would list it.
 */
export const signalListConditions = ({
  organizationId,
  canTriage,
  view,
  now,
}: SignalListAccessOptions): SQL =>
  and(
    eq(signals.organizationId, organizationId),
    signalVisibilityCondition(canTriage),
    viewCondition(view, now),
  ) ?? panic("Signal list conditions compiled to nothing");

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
  workspaceName: workspaces.name,
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
  assigneeUserName: sql<
    string | null
  >`coalesce(nullif(trim(${user.name}), ''), ${user.email})`,
  assigneeUserImage: user.image,
  createdByUserId: signals.createdByUserId,
  dismissReason: signals.dismissReason,
  acceptedResult: signals.acceptedResult,
  resolvedAt: signals.resolvedAt,
  createdAt: signals.createdAt,
  updatedAt: signals.updatedAt,
};

/** The signal row with its matter name and assignee display, one join each. */
const selectSignals = (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) =>
  tx
    .select(signalColumns)
    .from(signals)
    .leftJoin(workspaces, eq(workspaces.id, signals.workspaceId))
    .leftJoin(
      member,
      and(
        eq(member.userId, signals.assigneeUserId),
        eq(member.organizationId, organizationId),
      ),
    )
    .leftJoin(user, eq(user.id, member.userId));

type SignalRow = Omit<
  typeof signals.$inferSelect,
  "organizationId" | "dedupeKey"
>;

export const serializeSignal = <TRow extends SignalRow>(row: TRow) => {
  const { snoozedUntil, resolvedAt, createdAt, updatedAt, ...signal } = row;
  return {
    ...signal,
    snoozedUntil: snoozedUntil?.toISOString() ?? null,
    resolvedAt: resolvedAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
};

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
    signalListConditions({
      organizationId,
      canTriage,
      view: query.view ?? SIGNAL_VIEW.OPEN,
      now,
    }),
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
    const boundaryRows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({ id: signals.id })
          .from(signals)
          .where(
            and(
              eq(signals.id, cursor),
              eq(signals.organizationId, organizationId),
              signalVisibilityCondition(canTriage),
            ),
          )
          .limit(1),
      ),
    );
    const boundary = boundaryRows.at(0);
    if (!boundary) {
      return Result.err(
        new HandlerError({ status: 400, message: "Invalid cursor" }),
      );
    }
    conditions.push(
      sql`(${signals.createdAt}, ${signals.id}) < (
        (SELECT cursor_boundary.created_at
          FROM signals cursor_boundary
          WHERE cursor_boundary.id = ${boundary.id}),
        ${boundary.id}
      )`,
    );
  }

  const rows = yield* Result.await(
    safeDb((tx) =>
      selectSignals(tx, organizationId)
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
      selectSignals(tx, organizationId)
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

type ListVisibleSignalsByIdsOptions = {
  safeDb: SafeDb;
  access: SignalListAccessOptions;
  signalIds: readonly SafeId<"signal">[];
};

/**
 * Hydrates a page of signal ids chosen by another query (the Inbox window),
 * re-applying the list's access and view predicate rather than trusting the
 * ids. Rows come back unordered; the caller owns the order.
 */
export const listVisibleSignalsByIds = async ({
  safeDb,
  access,
  signalIds,
}: ListVisibleSignalsByIdsOptions) => {
  const rows = await safeDb((tx) =>
    selectSignals(tx, access.organizationId).where(
      and(inArray(signals.id, [...signalIds]), signalListConditions(access)),
    ),
  );
  return Result.isError(rows)
    ? Result.err(rows.error)
    : Result.ok(rows.value.map(serializeSignal));
};

/** Open signals the caller can see: the list's own predicate, counted. */
export const countOpenSignals = async ({
  safeDb,
  organizationId,
  canTriage,
}: Omit<GetSignalProps, "signalId">) =>
  await safeDb((tx) =>
    tx.$count(
      signals,
      signalListConditions({
        organizationId,
        canTriage,
        view: SIGNAL_VIEW.OPEN,
        now: new Date(),
      }),
    ),
  );
