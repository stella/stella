import { panic, Result } from "better-result";
import { and, asc, desc, eq, gt, inArray, lte, or, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { member } from "@/api/db/auth-schema";
import { SETTING_ORGANIZATION_ID } from "@/api/db/rls";
import type { rootDb, Transaction } from "@/api/db/root";
import { accountExports, auditLogs } from "@/api/db/schema";
import {
  ACCOUNT_EXPORT_ACTIVE_STATUSES,
  ACCOUNT_EXPORT_LIMITS,
} from "@/api/lib/account-export/constants";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
  ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
} from "@/api/lib/audit-log";
import type { AccountAuditEventType } from "@/api/lib/audit-log.constants";
import type { SafeId } from "@/api/lib/branded-types";
import { lockActiveAccountRow } from "@/api/lib/db/account-row";
import {
  withAggregateRowQuery,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { TRANSITIONS } from "@/api/lib/db/transition-specs";
import { transition } from "@/api/lib/db/transitions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  createCursorPage,
  decodePaginationCursor,
  encodePaginationCursor,
  isUuidPaginationCursorPart,
  type Page,
} from "@/api/lib/pagination";

export type AccountExportRow = typeof accountExports.$inferSelect;
export type AccountExportDb = Pick<typeof rootDb, "transaction">;

/** What one export's archive is built from. */
export type AccountExportSubject =
  | { kind: "account" }
  | { kind: "organization_audit"; organizationId: SafeId<"organization"> };

/** The audit rows one organization audit archive holds. */
export type OrganizationAuditCoverage = {
  rowCount: number;
  coveredThrough: Date | null;
};

/** What a finished build publishes; it always matches its claim's subject. */
export type AccountExportBuild =
  | { kind: "account" }
  | { kind: "organization_audit"; coverage: OrganizationAuditCoverage };

export const accountExportSubject = (
  row: Pick<AccountExportRow, "kind" | "organizationId">,
): AccountExportSubject => {
  switch (row.kind) {
    case "account":
      return { kind: "account" };
    case "organization_audit":
      return {
        kind: "organization_audit",
        organizationId:
          row.organizationId ??
          panic("Organization audit export requires its organization"),
      };
    default: {
      row.kind satisfies never;
      return panic("Unknown account export kind");
    }
  }
};

export type AccountExportClaim = {
  id: string;
  userId: SafeId<"user">;
  subject: AccountExportSubject;
  token: string;
  objectKey: string;
  leaseExpiresAt: Date;
};
export type AccountExportStatus =
  | { status: "requested" | "processing" | "failed" | "expired"; id: string }
  | { status: "ready"; id: string; expiresAt: Date };

export const accountExportStatus = (
  row: Pick<AccountExportRow, "id" | "status" | "expiresAt">,
): AccountExportStatus => {
  switch (row.status) {
    case "ready":
      if (row.expiresAt === null) {
        panic("Ready account export requires expiry");
      }
      if (row.expiresAt.getTime() <= Temporal.Now.instant().epochMilliseconds) {
        return { status: "expired", id: row.id };
      }
      return { status: "ready", id: row.id, expiresAt: row.expiresAt };
    case "requested":
    case "processing":
    case "failed":
    case "expired":
      return { status: row.status, id: row.id };
    default: {
      row.status satisfies never;
      return panic("Unknown account export status");
    }
  }
};

// Account scope precedes any organization selection; workers reconcile the
// durable ledger across accounts through this owning module only.
const resolveDatabase = async (db: AccountExportDb | undefined) => {
  if (db !== undefined) {
    return db;
  }
  const { rlsDb } = await import("@/api/db/root");
  return rlsDb;
};

const scopeAccount = async (tx: Transaction, userId: SafeId<"user">) => {
  await tx.execute(sql`SET LOCAL ROLE stella`);
  await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
};

const claimable = () =>
  or(
    eq(accountExports.status, "requested"),
    and(
      eq(accountExports.status, "processing"),
      lte(accountExports.leaseExpiresAt, sql`clock_timestamp()`),
    ),
  );

/** A row-locked ledger entry and its deadlines on the database clock. */
type LockedAccountExport = {
  row: AccountExportRow;
  leaseElapsed: boolean;
  readyElapsed: boolean;
};

const lockAccountExport = async (
  tx: Transaction,
  { id, userId }: { id: string; userId: SafeId<"user"> },
): Promise<LockedAccountExport | null> => {
  const locked = await withAggregateRowQuery({
    tx,
    aggregate: "accountExport",
    id: { id, userId },
    mode: "no key update",
    select: (lockedTx) => lockedTx.select().from(accountExports),
  });
  const row = locked.rows.at(0);
  if (row === undefined) {
    return null;
  }
  const deadlines = await tx
    .select({
      leaseElapsed: sql<boolean>`coalesce(${accountExports.leaseExpiresAt} <= clock_timestamp(), false)`,
      readyElapsed: sql<boolean>`coalesce(${accountExports.expiresAt} <= clock_timestamp(), false)`,
    })
    .from(accountExports)
    .where(eq(accountExports.id, id))
    .limit(1);
  const deadline =
    deadlines.at(0) ?? panic("Locked account export has no deadline row");
  return { row, ...deadline };
};

const holdsClaim = (
  locked: LockedAccountExport | null,
  claim: AccountExportClaim,
): locked is LockedAccountExport =>
  locked?.row.status === "processing" &&
  locked.row.claimToken === claim.token &&
  locked.row.objectKey === claim.objectKey &&
  !locked.leaseElapsed;

const RELEASED_ATTEMPT = {
  claimToken: null,
  leaseExpiresAt: null,
  objectKey: null,
  expiresAt: null,
  updatedAt: sql`clock_timestamp()`,
};

const recordAccountExportTransition =
  (userId: SafeId<"user">, type: AccountAuditEventType) =>
  async (tx: Transaction, { id }: { id: string }) => {
    await createBackgroundAuditRecorder({ account: { userId } })(tx, {
      type,
      resourceId: id,
    });
  };

// Lease claims, retries and retry exhaustion change only the request's derived
// execution state. The account trail records the request, its readiness,
// every download and expiry.
const executionStateOnly = async (): Promise<void> => {
  // No account event: the transition itself is the durable record.
};

const expireReadyAccountExport = async (
  tx: Transaction,
  row: AccountExportRow,
): Promise<boolean> => {
  const moved = await transition({
    tx,
    spec: TRANSITIONS.accountExports,
    id: row.id,
    options: { from: ["ready"], to: "expired", set: RELEASED_ATTEMPT },
    recordTransitionAuditEvent: recordAccountExportTransition(
      row.userId,
      "account.data_export.expired",
    ),
  });
  return moved.type === "transitioned";
};

type RequestAccountExportOptions = {
  db?: AccountExportDb;
};
export const requestAccountExport = async (
  userId: SafeId<"user">,
  { db }: RequestAccountExportOptions = {},
): Promise<Result<AccountExportRow, HandlerError>> => {
  const database = await resolveDatabase(db);
  return await withAggregateTransaction(database, async (tx) => {
    await lockActiveAccountRow(tx, userId);
    await scopeAccount(tx, userId);
    const existing = await tx
      .select({ id: accountExports.id })
      .from(accountExports)
      .where(
        and(
          eq(accountExports.userId, userId),
          eq(accountExports.kind, "account"),
          inArray(accountExports.status, ACCOUNT_EXPORT_ACTIVE_STATUSES),
        ),
      )
      .limit(1);
    const activeId = existing.at(0)?.id;
    const active =
      activeId === undefined
        ? undefined
        : ((await lockAccountExport(tx, { id: activeId, userId })) ??
          panic("Active account export left under the account lock"));
    if (active !== undefined) {
      switch (active.row.status) {
        case "requested":
        case "processing":
          return Result.ok(active.row);
        case "ready":
          if (!active.readyElapsed) {
            return Result.ok(active.row);
          }
          break;
        case "failed":
        case "expired":
          break;
        default:
          active.row.status satisfies never;
          panic("Unknown account export status");
      }
    }
    return await insertRequestedExport(tx, {
      userId,
      subject: { kind: "account" },
      replacing: active,
    });
  });
};

const subjectPredicate = (subject: AccountExportSubject) =>
  subject.kind === "account"
    ? eq(accountExports.kind, "account")
    : and(
        eq(accountExports.kind, "organization_audit"),
        eq(accountExports.organizationId, subject.organizationId),
      );

type InsertRequestedExportOptions = {
  userId: SafeId<"user">;
  subject: AccountExportSubject;
  replacing: LockedAccountExport | undefined;
};

/**
 * Insert a new request under the account lock, within the hourly budget of
 * its subject, after retiring the ready export it replaces.
 */
const insertRequestedExport = async (
  tx: Transaction,
  { userId, subject, replacing }: InsertRequestedExportOptions,
): Promise<Result<AccountExportRow, HandlerError>> => {
  // The account lock serializes this indexed, bounded budget check with
  // insertion. Returning an active export never consumes a request slot.
  const budgetExhausted = await tx
    .select({ id: accountExports.id })
    .from(accountExports)
    .where(
      and(
        eq(accountExports.userId, userId),
        subjectPredicate(subject),
        sql`${accountExports.createdAt} > CURRENT_TIMESTAMP - (${ACCOUNT_EXPORT_LIMITS.requestWindowMs} * INTERVAL '1 millisecond')`,
      ),
    )
    .offset(ACCOUNT_EXPORT_LIMITS.requestsPerWindow - 1)
    .limit(1);
  if (budgetExhausted.at(0) !== undefined) {
    return Result.err(
      new HandlerError({
        status: 429,
        code: "account_export_request_limited",
        message: "Try again later.",
      }),
    );
  }
  if (
    replacing?.row.status === "ready" &&
    !(await expireReadyAccountExport(tx, replacing.row))
  ) {
    panic("Locked account export changed under its lock");
  }
  const rows = await tx
    .insert(accountExports)
    .values({
      id: Bun.randomUUIDv7(),
      userId,
      kind: subject.kind,
      organizationId:
        subject.kind === "organization_audit" ? subject.organizationId : null,
    })
    .returning();
  const created = rows.at(0);
  if (created === undefined) {
    panic("Account export insertion returned no row");
  }
  await createBackgroundAuditRecorder({ account: { userId } })(tx, {
    type: "account.data_export.requested",
    resourceId: created.id,
  });
  return Result.ok(created);
};

/**
 * The organization's audit rows as of this statement. Callers that need the
 * count to stay true hold the organization row lock, which every audit insert
 * waits for through its foreign key.
 */
export const countOrganizationAuditRows = async (
  tx: Pick<Transaction, "select">,
  organizationId: SafeId<"organization">,
): Promise<number> => {
  const rows = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, organizationId));
  return rows.at(0)?.count ?? panic("Audit row count returned no row");
};

/** Whether a ready organization audit archive still holds every audit row. */
export const coversCurrentAuditTrail = (
  row: Pick<AccountExportRow, "auditRowCount">,
  liveRowCount: number,
): boolean => row.auditRowCount === liveRowCount;

const isOrganizationOwner = async (
  tx: Pick<Transaction, "select">,
  {
    organizationId,
    userId,
  }: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
): Promise<boolean> => {
  const rows = await tx
    .select({ id: member.id })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, userId),
        eq(member.role, "owner"),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

const organizationAuditExportForbidden = () =>
  new HandlerError({
    status: 403,
    code: "organization_audit_export_forbidden",
    message: "Only an owner of the organization can export its audit log.",
  });

/** Scope the account transaction to the organization whose trail it reads. */
const scopeOrganizationAudit = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
) => {
  await tx.execute(
    sql`SELECT set_config(${SETTING_ORGANIZATION_ID}, ${organizationId}, true)`,
  );
};

type OrganizationAuditExportOptions = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  db?: AccountExportDb;
};

/**
 * Request an archive of the organization's whole audit trail for one of its
 * owners. An archive that is still building, or ready and still holding every
 * audit row, is returned as it is; a ready archive the trail has outgrown is
 * replaced.
 */
export const requestOrganizationAuditExport = async ({
  userId,
  organizationId,
  db,
}: OrganizationAuditExportOptions): Promise<
  Result<AccountExportRow, HandlerError>
> => {
  const database = await resolveDatabase(db);
  return await withAggregateTransaction(database, async (tx) => {
    await lockActiveAccountRow(tx, userId);
    if (!(await isOrganizationOwner(tx, { organizationId, userId }))) {
      return Result.err(organizationAuditExportForbidden());
    }
    await scopeAccount(tx, userId);
    await scopeOrganizationAudit(tx, organizationId);
    const subject = {
      kind: "organization_audit",
      organizationId,
    } as const satisfies AccountExportSubject;
    const existing = await tx
      .select({ id: accountExports.id })
      .from(accountExports)
      .where(
        and(
          eq(accountExports.userId, userId),
          subjectPredicate(subject),
          inArray(accountExports.status, ACCOUNT_EXPORT_ACTIVE_STATUSES),
        ),
      )
      .limit(1);
    const activeId = existing.at(0)?.id;
    const active =
      activeId === undefined
        ? undefined
        : ((await lockAccountExport(tx, { id: activeId, userId })) ??
          panic("Active audit export left under the account lock"));
    if (active !== undefined) {
      switch (active.row.status) {
        case "requested":
        case "processing":
          return Result.ok(active.row);
        case "ready":
          if (
            !active.readyElapsed &&
            coversCurrentAuditTrail(
              active.row,
              await countOrganizationAuditRows(tx, organizationId),
            )
          ) {
            return Result.ok(active.row);
          }
          break;
        case "failed":
        case "expired":
          break;
        default:
          active.row.status satisfies never;
          panic("Unknown account export status");
      }
    }
    const created = await insertRequestedExport(tx, {
      userId,
      subject,
      replacing: active,
    });
    if (Result.isOk(created)) {
      // The organization's own trail records that its audit log was exported.
      // Written before the archive is built, so the archive holds it too.
      await createBackgroundAuditRecorder({
        organizationId,
        workspaceId: null,
        userId,
        execution: {
          performer: { type: "user", id: userId },
          trigger: { type: "direct" },
        },
      })(tx, {
        action: AUDIT_ACTION.CREATE,
        resourceType: AUDIT_RESOURCE_TYPE.AUDIT_LOG,
        resourceId: ORGANIZATION_AUDIT_LOG_RESOURCE_ID,
      });
    }
    return created;
  });
};

/**
 * Lock the owner's ready, unexpired audit archive of the organization, for
 * the deletion that requires it. Account exports precede organizations in the
 * registered lock order, so callers take this before the organization row.
 */
export const lockReadyOrganizationAuditExport = async (
  tx: Transaction,
  {
    organizationId,
    userId,
  }: { organizationId: SafeId<"organization">; userId: SafeId<"user"> },
): Promise<AccountExportRow | undefined> => {
  const candidates = await tx
    .select({ id: accountExports.id })
    .from(accountExports)
    .where(
      and(
        eq(accountExports.userId, userId),
        subjectPredicate({ kind: "organization_audit", organizationId }),
        eq(accountExports.status, "ready"),
      ),
    )
    .limit(1);
  const candidateId = candidates.at(0)?.id;
  if (candidateId === undefined) {
    return undefined;
  }
  const locked = await withAggregateRowQuery({
    tx,
    aggregate: "accountExport",
    id: { id: candidateId, userId },
    mode: "no key update",
    select: (lockedTx) => lockedTx.select().from(accountExports),
    where: sql`${eq(accountExports.status, "ready")} AND ${gt(accountExports.expiresAt, sql`clock_timestamp()`)}`,
  });
  return locked.rows.at(0);
};

// The account trail already records the archive's readiness and every
// download; keeping it reachable changes no state the owner acts on.
const retentionOnly = async (): Promise<void> => {
  // No account event: the transition itself is the durable record.
};

/**
 * Keep a locked ready archive downloadable for a full retention window from
 * now, so the owner can still fetch it after the organization is gone.
 */
export const retainOrganizationAuditExport = async (
  tx: Transaction,
  row: AccountExportRow,
): Promise<void> => {
  const retained = await transition({
    tx,
    spec: TRANSITIONS.accountExports,
    id: row.id,
    options: {
      from: ["ready"],
      to: "ready",
      set: {
        expiresAt: sql`greatest(${accountExports.expiresAt}, statement_timestamp() + (${ACCOUNT_EXPORT_LIMITS.ttlMs} * INTERVAL '1 millisecond'))`,
        updatedAt: sql`statement_timestamp()`,
      },
    },
    recordTransitionAuditEvent: retentionOnly,
  });
  if (retained.type === "stale") {
    panic("Locked organization audit export changed under its lock");
  }
};

export type OrganizationAuditExportView = {
  row: AccountExportRow;
  /** For a ready archive: whether it still holds every audit row. */
  coversCurrentTrail: boolean;
};

/** The owner's latest audit export of this organization, if any. */
export const readLatestOrganizationAuditExport = async ({
  userId,
  organizationId,
  db,
}: OrganizationAuditExportOptions): Promise<
  Result<OrganizationAuditExportView | null, HandlerError>
> => {
  const database = await resolveDatabase(db);
  return await withAggregateTransaction(database, async (tx) => {
    if (!(await isOrganizationOwner(tx, { organizationId, userId }))) {
      return Result.err(organizationAuditExportForbidden());
    }
    await scopeAccount(tx, userId);
    await scopeOrganizationAudit(tx, organizationId);
    const rows = await tx
      .select()
      .from(accountExports)
      .where(
        and(
          eq(accountExports.userId, userId),
          subjectPredicate({ kind: "organization_audit", organizationId }),
        ),
      )
      .orderBy(desc(accountExports.createdAt), desc(accountExports.id))
      .limit(1);
    const row = rows.at(0);
    if (row === undefined) {
      return Result.ok(null);
    }
    return Result.ok({
      row,
      coversCurrentTrail:
        row.status === "ready" &&
        coversCurrentAuditTrail(
          row,
          await countOrganizationAuditRows(tx, organizationId),
        ),
    });
  });
};

type ReadScopedAccountExportOptions = {
  tx: Transaction;
  id: string;
  userId: SafeId<"user">;
};
const readScopedAccountExport = async ({
  tx,
  id,
  userId,
}: ReadScopedAccountExportOptions): Promise<AccountExportRow | null> => {
  const rows = await tx
    .select()
    .from(accountExports)
    .where(and(eq(accountExports.id, id), eq(accountExports.userId, userId)))
    .limit(1);
  return rows.at(0) ?? null;
};

type ReadAccountExportOptions = {
  id: string;
  userId: SafeId<"user">;
  db?: AccountExportDb;
};
export const readAccountExport = async ({
  id,
  userId,
  db,
}: ReadAccountExportOptions): Promise<AccountExportRow | null> => {
  const database = await resolveDatabase(db);
  return await withAggregateTransaction(database, async (tx) => {
    await scopeAccount(tx, userId);
    return await readScopedAccountExport({ tx, id, userId });
  });
};

export const readLatestAccountExport = async (
  userId: SafeId<"user">,
  db?: AccountExportDb,
): Promise<AccountExportRow | null> => {
  const database = await resolveDatabase(db);
  return await withAggregateTransaction(database, async (tx) => {
    await scopeAccount(tx, userId);
    const rows = await tx
      .select({ id: accountExports.id })
      .from(accountExports)
      .where(
        and(
          eq(accountExports.userId, userId),
          eq(accountExports.kind, "account"),
        ),
      )
      .orderBy(desc(accountExports.createdAt), desc(accountExports.id))
      .limit(1);
    const latest = rows.at(0);
    return latest === undefined
      ? null
      : await readScopedAccountExport({ tx, id: latest.id, userId });
  });
};

const claimSource = ({ row, leaseElapsed }: LockedAccountExport) => {
  if (row.status === "requested") {
    return row.status;
  }
  return row.status === "processing" && leaseElapsed ? row.status : null;
};

export const claimAccountExport = async (
  id: string,
  db: AccountExportDb,
): Promise<AccountExportClaim | null> =>
  await withAggregateTransaction(db, async (tx) => {
    const owners = await tx
      .select({ userId: accountExports.userId })
      .from(accountExports)
      .where(eq(accountExports.id, id))
      .limit(1);
    const userId = owners.at(0)?.userId;
    if (userId === undefined) {
      return null;
    }
    await lockActiveAccountRow(tx, userId);
    const locked = await lockAccountExport(tx, { id, userId });
    const source = locked === null ? null : claimSource(locked);
    if (locked === null || source === null) {
      return null;
    }
    // A crashed final attempt becomes terminal before another worker can claim.
    if (locked.row.attemptCount >= ACCOUNT_EXPORT_LIMITS.attempts) {
      const exhausted = await transition({
        tx,
        spec: TRANSITIONS.accountExports,
        id,
        options: { from: [source], to: "failed", set: RELEASED_ATTEMPT },
        recordTransitionAuditEvent: executionStateOnly,
      });
      if (exhausted.type === "stale") {
        panic("Locked account export changed under its lock");
      }
      return null;
    }
    const token = Bun.randomUUIDv7();
    const objectKey = `account-exports/${userId}/${id}/${token}.zip`;
    // Reclaiming an expired lease stays in processing: a same-state write the
    // transition owner permits without a graph edge.
    const claimed = await transition({
      tx,
      spec: TRANSITIONS.accountExports,
      id,
      options: {
        from: [source],
        to: "processing",
        set: {
          claimToken: token,
          leaseExpiresAt: sql`clock_timestamp() + (${ACCOUNT_EXPORT_LIMITS.leaseMs} * INTERVAL '1 millisecond')`,
          objectKey,
          attemptCount: sql`${accountExports.attemptCount} + 1`,
          attemptObjectKeys: sql`${accountExports.attemptObjectKeys} || jsonb_build_array(${objectKey}::text)`,
          updatedAt: sql`clock_timestamp()`,
        },
      },
      recordTransitionAuditEvent: executionStateOnly,
    });
    if (claimed.type === "stale") {
      panic("Locked account export changed under its lock");
    }
    const leases = await tx
      .select({ leaseExpiresAt: accountExports.leaseExpiresAt })
      .from(accountExports)
      .where(eq(accountExports.id, id))
      .limit(1);
    const leaseExpiresAt =
      leases.at(0)?.leaseExpiresAt ??
      panic("Claimed export requires a lease deadline");
    return {
      id,
      userId,
      subject: accountExportSubject(locked.row),
      token,
      objectKey,
      leaseExpiresAt,
    };
  });

type CompleteAccountExportOptions = {
  claim: AccountExportClaim;
  objectKey: string;
  built: AccountExportBuild;
  db: AccountExportDb;
};

const coverageColumns = (built: AccountExportBuild) =>
  built.kind === "organization_audit"
    ? {
        auditRowCount: built.coverage.rowCount,
        auditCoveredThrough: built.coverage.coveredThrough,
      }
    : {};

export const completeAccountExport = async ({
  claim,
  objectKey,
  built,
  db,
}: CompleteAccountExportOptions): Promise<boolean> => {
  if (objectKey !== claim.objectKey) {
    panic("Account export object differs from its claim");
  }
  if (built.kind !== claim.subject.kind) {
    panic("Account export build differs from its claim");
  }
  return await withAggregateTransaction(db, async (tx) => {
    await lockActiveAccountRow(tx, claim.userId);
    const locked = await lockAccountExport(tx, claim);
    if (!holdsClaim(locked, claim)) {
      return false;
    }
    const moved = await transition({
      tx,
      spec: TRANSITIONS.accountExports,
      id: claim.id,
      options: {
        from: ["processing"],
        to: "ready",
        set: {
          claimToken: null,
          leaseExpiresAt: null,
          // clock_timestamp() advances within a statement; one instant keeps
          // the expiry exactly one TTL after the ready transition.
          expiresAt: sql`statement_timestamp() + (${ACCOUNT_EXPORT_LIMITS.ttlMs} * INTERVAL '1 millisecond')`,
          updatedAt: sql`statement_timestamp()`,
          ...coverageColumns(built),
        },
      },
      recordTransitionAuditEvent: recordAccountExportTransition(
        claim.userId,
        "account.data_export.ready",
      ),
    });
    return moved.type === "transitioned";
  });
};

export const failAccountExport = async (
  claim: AccountExportClaim,
  db: AccountExportDb,
): Promise<boolean> =>
  await withAggregateTransaction(db, async (tx) => {
    const locked = await lockAccountExport(tx, claim);
    if (!holdsClaim(locked, claim)) {
      return false;
    }
    const exhausted = locked.row.attemptCount >= ACCOUNT_EXPORT_LIMITS.attempts;
    const moved = await transition({
      tx,
      spec: TRANSITIONS.accountExports,
      id: claim.id,
      options: exhausted
        ? { from: ["processing"], to: "failed", set: RELEASED_ATTEMPT }
        : { from: ["processing"], to: "requested", set: RELEASED_ATTEMPT },
      recordTransitionAuditEvent: executionStateOnly,
    });
    return moved.type === "transitioned";
  });

export const expireAccountExport = async (
  id: string,
  db: AccountExportDb,
): Promise<AccountExportRow | null> =>
  await withAggregateTransaction(db, async (tx) => {
    const owners = await tx
      .select({ userId: accountExports.userId })
      .from(accountExports)
      .where(eq(accountExports.id, id))
      .limit(1);
    const userId = owners.at(0)?.userId;
    if (userId === undefined) {
      return null;
    }
    const locked = await lockAccountExport(tx, { id, userId });
    if (
      locked?.row.status !== "ready" ||
      !locked.readyElapsed ||
      !(await expireReadyAccountExport(tx, locked.row))
    ) {
      return null;
    }
    return await readScopedAccountExport({ tx, id, userId });
  });

const artifactCleanupEligible = () =>
  and(
    inArray(accountExports.status, ["failed", "expired"]),
    sql`${accountExports.updatedAt} + (${ACCOUNT_EXPORT_LIMITS.leaseMs + ACCOUNT_EXPORT_LIMITS.publicationCancellationMarginMs} * INTERVAL '1 millisecond') <= clock_timestamp()`,
  );

export const canReclaimAccountExportObjects = async (
  id: string,
  db: AccountExportDb,
): Promise<boolean> =>
  await withAggregateTransaction(db, async (tx) => {
    const rows = await tx
      .select({ id: accountExports.id })
      .from(accountExports)
      .where(and(eq(accountExports.id, id), artifactCleanupEligible()))
      .limit(1);
    return rows.length > 0;
  });

export const clearAccountExportObjects = async (
  id: string,
  db: AccountExportDb,
): Promise<void> => {
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - Artifact reclamation clears derived storage references after lifecycle expiry or failure.
    await tx
      .update(accountExports)
      .set({ attemptObjectKeys: [], updatedAt: sql`clock_timestamp()` })
      .where(and(eq(accountExports.id, id), artifactCleanupEligible()));
  });
};

/** Attempt keys are never reused after a claim is revoked. A worker may
 * reclaim its own upload only once the durable winner no longer names it. */
export const canReclaimAccountExportAttempt = async (
  claim: AccountExportClaim,
  db: AccountExportDb,
): Promise<boolean> =>
  await withAggregateTransaction(db, async (tx) => {
    const rows = await tx
      .select({
        status: accountExports.status,
        objectKey: accountExports.objectKey,
      })
      .from(accountExports)
      .where(
        and(
          eq(accountExports.id, claim.id),
          eq(accountExports.userId, claim.userId),
        ),
      )
      .limit(1);
    const row = rows.at(0);
    return (
      row === undefined ||
      row.objectKey !== claim.objectKey ||
      (row.status !== "processing" && row.status !== "ready")
    );
  });

export const recordAccountExportDownload = async ({
  id,
  userId,
  db,
}: ReadAccountExportOptions): Promise<AccountExportRow | null> => {
  const database = await resolveDatabase(db);
  return await withAggregateTransaction(database, async (tx) => {
    await lockActiveAccountRow(tx, userId);
    await scopeAccount(tx, userId);
    const result = await withAggregateRowQuery({
      tx,
      aggregate: "accountExport",
      id: { id, userId },
      mode: "share",
      select: (lockedTx) => lockedTx.select().from(accountExports),
      where: sql`${eq(accountExports.status, "ready")} AND ${gt(accountExports.expiresAt, sql`clock_timestamp()`)}`,
    });
    const row = result.rows.at(0);
    if (row === undefined) {
      return null;
    }
    await createBackgroundAuditRecorder({ account: { userId } })(tx, {
      type: "account.data_export.downloaded",
      resourceId: id,
    });
    return row;
  });
};

export const listRecoverableAccountExports = async (
  db: AccountExportDb,
  cursor?: string | null,
): Promise<Page<AccountExportRow>> => {
  const parts = cursor ? decodePaginationCursor(cursor) : null;
  const afterId = parts?.at(0);
  // Only the reconciler mints this cursor, from a page it has just read.
  if (cursor && (parts?.length !== 1 || !isUuidPaginationCursorPart(afterId))) {
    panic("Account export recovery cursor is malformed");
  }
  return await withAggregateTransaction(db, async (tx) => {
    const rows = await tx
      .select()
      .from(accountExports)
      .where(
        and(
          or(
            claimable(),
            and(
              eq(accountExports.status, "ready"),
              lte(accountExports.expiresAt, sql`clock_timestamp()`),
            ),
            and(
              artifactCleanupEligible(),
              sql`jsonb_array_length(${accountExports.attemptObjectKeys}) > 0`,
            ),
          ),
          typeof afterId === "string"
            ? gt(accountExports.id, afterId)
            : undefined,
        ),
      )
      .orderBy(asc(accountExports.id))
      .limit(ACCOUNT_EXPORT_LIMITS.recoveryPageSize + 1);
    const page = createCursorPage({
      rows,
      limit: ACCOUNT_EXPORT_LIMITS.recoveryPageSize,
      cursorForItem: ({ id }) => encodePaginationCursor([id]),
    });
    return page;
  });
};
