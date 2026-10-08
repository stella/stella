import { Result, TaggedError } from "better-result";
import { and, asc, eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { createFencedRlsDatabase } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import {
  clauses,
  contacts,
  playbookDefinitions,
  templates,
  workspaces,
} from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import type { RlsDatabase } from "@/api/db/scoped";
import { deleteClauseHandler } from "@/api/handlers/clauses/delete";
import { deleteContactHandler } from "@/api/handlers/contacts/delete";
import { deleteTemplateHandler } from "@/api/handlers/templates/delete";
import { unarchiveWorkspaceHandler } from "@/api/handlers/workspaces/unarchive";
import { captureError } from "@/api/lib/analytics/capture";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import type { BoundedReadResult } from "@/api/lib/db/read-bounded";
import { handoffCommittedEntityDeletionCleanupBatch } from "@/api/lib/entity-deletion-cleanup-handoff";
import { enqueueEntityDeletionCleanup } from "@/api/lib/entity-deletion-cleanup-queue";
import { LIMITS } from "@/api/lib/limits";
import { isMemberRole } from "@/api/lib/member-roles";
import type { MemberRole } from "@/api/lib/member-roles";
import { recordOrganizationStorageTeardown } from "@/api/lib/organization-storage-teardown";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { ReviewOrganizationConfig } from "@/api/lib/review-organization/config";
import { inOrder } from "@/api/lib/review-organization/in-order";
import { sweepReviewOrganization } from "@/api/lib/review-organization/reset-scope";
import { seedReviewOrganization } from "@/api/lib/review-organization/seed";
import {
  ReviewSeedError,
  seedCancellation,
} from "@/api/lib/review-organization/seed-common";
import type {
  ReviewSeedCounts,
  ReviewSeedDependencies,
} from "@/api/lib/review-organization/seed-common";
import {
  createRootMembershipSafeDb,
  createRootMembershipScopedDb,
} from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import type { SchedulerDb } from "@/api/lib/scheduler/types";
import { executeAuthorizedWorkspaceDeletion } from "@/api/lib/workspace-deletion";
import type { WorkspaceDeletionDependencies } from "@/api/lib/workspace-deletion";

export const REVIEW_RESET_REFUSAL = {
  unconfigured: "unconfigured",
  demoOrganization: "demo-organization",
  demoAccount: "demo-account",
  organizationMissing: "organization-missing",
  accountMissing: "account-missing",
  accountNotMember: "account-not-member",
  otherMembers: "other-members",
  unknownRole: "unknown-role",
} as const;

export type ReviewResetRefusalReason =
  (typeof REVIEW_RESET_REFUSAL)[keyof typeof REVIEW_RESET_REFUSAL];

/** The reset would not run: the target is not the restricted review organization. */
export class ReviewResetRefusedError extends TaggedError(
  "ReviewResetRefusedError",
)<{
  message: string;
  reason: ReviewResetRefusalReason;
}> {}

const refuse = (reason: ReviewResetRefusalReason, message: string) =>
  Result.err(new ReviewResetRefusedError({ message, reason }));

/** The organization a reset may act on, proved by `resolveReviewTarget`. */
export type ReviewTarget = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  email: string;
  role: MemberRole;
};

/**
 * Prove the configured organization is the restricted review organization: it
 * exists, it is not the demo organization, and its only member is the
 * configured review account. Anything else refuses, so the reset can never
 * reach an organization a real member belongs to.
 */
const resolveReviewTarget = async (
  config: ReviewOrganizationConfig | null,
  db: SchedulerDb,
): Promise<Result<ReviewTarget, ReviewResetRefusedError>> => {
  if (config === null) {
    return refuse(
      REVIEW_RESET_REFUSAL.unconfigured,
      "No restricted review organization is configured",
    );
  }
  if (
    config.demoOrganizationId !== null &&
    config.demoOrganizationId === config.organizationId
  ) {
    return refuse(
      REVIEW_RESET_REFUSAL.demoOrganization,
      "The review organization must not be the demo organization",
    );
  }
  if (config.demoEmail !== null && config.demoEmail === config.email) {
    return refuse(
      REVIEW_RESET_REFUSAL.demoAccount,
      "The review account must not be the demo account",
    );
  }

  const facts = await db.transaction(async (tx) => {
    const organizationRows = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, config.organizationId))
      .limit(1);
    // At most one account and one member may match; a second of either is
    // read as an overflow, never as a row to act on.
    const accounts = await readBounded(
      tx
        .select({ id: user.id })
        .from(user)
        .where(sql`lower(${user.email}) = ${config.email}`),
      1,
    );
    const members = await readBounded(
      tx
        .select({ userId: member.userId, role: member.role })
        .from(member)
        .where(eq(member.organizationId, config.organizationId))
        .orderBy(asc(member.userId)),
      1,
    );
    return { organizationRows, accounts, members };
  });

  if (facts.organizationRows.length === 0) {
    return refuse(
      REVIEW_RESET_REFUSAL.organizationMissing,
      "The review organization does not exist",
    );
  }
  const account =
    facts.accounts.type === "complete" ? facts.accounts.rows.at(0) : undefined;
  if (account === undefined) {
    return refuse(
      REVIEW_RESET_REFUSAL.accountMissing,
      "The review account does not exist",
    );
  }
  if (facts.members.type === "overflow") {
    return refuse(
      REVIEW_RESET_REFUSAL.otherMembers,
      "The review organization has members other than the review account",
    );
  }
  const reviewMember = facts.members.rows.find(
    (row) => row.userId === account.id,
  );
  if (!reviewMember) {
    return refuse(
      REVIEW_RESET_REFUSAL.accountNotMember,
      "The review account is not a member of the review organization",
    );
  }
  if (!isMemberRole(reviewMember.role)) {
    return refuse(
      REVIEW_RESET_REFUSAL.unknownRole,
      "The review account has an unknown role",
    );
  }
  return Result.ok({
    organizationId: config.organizationId,
    userId: brandPersistedUserId(account.id),
    email: config.email,
    role: reviewMember.role,
  });
};

type ReviewResetKind =
  | "matters"
  | "contacts"
  | "clauses"
  | "templates"
  | "playbooks"
  | "sweep";

/** One row the reset could not delete, and why. */
type ReviewResetFailure = {
  kind: ReviewResetKind;
  id: string;
  reason: string;
};

export type ReviewResetReport = {
  deleted: Record<Exclude<ReviewResetKind, "sweep">, number>;
  /** Rows the closing sweep removed, per table. */
  swept: ReadonlyMap<string, number>;
  failures: ReviewResetFailure[];
  seed: Result<ReviewSeedCounts, ReviewSeedError>;
};

export type ReviewResetDependencies = {
  seed?: ReviewSeedDependencies | undefined;
  workspaceDeletion?: Omit<WorkspaceDeletionDependencies, "database">;
  /** Test seam: runs after the target is proved, before the first delete. */
  afterTargetResolved?: (() => Promise<void>) | undefined;
  /** Test seam: runs after the per-row deletes, before the sweep transaction. */
  beforeSweep?: (() => Promise<void>) | undefined;
  /** Test seam: runs inside each fenced transaction once the fence holds. */
  afterFenceCheck?: (() => Promise<void>) | undefined;
};

/** A matter stood in the review organization when the sweep took its lock. */
class ReviewSweepBlockedError extends TaggedError("ReviewSweepBlockedError")<{
  message: string;
}> {}

/** The review organization gained a member while the reset ran. */
class ReviewMembershipChangedError extends TaggedError(
  "ReviewMembershipChangedError",
)<{ message: string }> {}

/**
 * Holds sole membership for the length of each transaction the reset writes
 * in. It first locks the organization row `FOR UPDATE` as the owner, before
 * any role switch: a membership insert checks its foreign key to that row
 * with `FOR KEY SHARE`, which conflicts, so a concurrent join waits until the
 * transaction ends. With the lock held it re-proves that the review account is
 * the only member and rolls the transaction back otherwise. Once tripped it
 * stays tripped: every later transaction refuses, and the reset stops without
 * seeding.
 */
export type MembershipFence = {
  tripped: boolean;
  assert: (tx: Pick<Transaction, "select">) => Promise<void>;
};

export const createMembershipFence = (
  target: ReviewTarget,
  afterCheck: (() => Promise<void>) | undefined,
): MembershipFence => {
  const fence: MembershipFence = {
    tripped: false,
    assert: async (tx) => {
      if (!fence.tripped) {
        await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, target.organizationId))
          .for("update");
      }
      const members = fence.tripped
        ? null
        : await readBounded(
            tx
              .select({ userId: member.userId })
              .from(member)
              .where(eq(member.organizationId, target.organizationId))
              .orderBy(asc(member.userId)),
            1,
          );
      const sole =
        members?.type === "complete" ? members.rows.at(0) : undefined;
      if (sole?.userId !== target.userId) {
        fence.tripped = true;
        abortTransaction(
          new ReviewMembershipChangedError({
            message:
              "The review organization has members other than the review account",
          }),
        );
      }
      await afterCheck?.();
    },
  };
  return fence;
};

/**
 * The application-role connection with the fence taken first in each
 * transaction, while it still runs as the owner; the scoped handle switches
 * to the application role after it.
 */
const fencedRlsDatabase = (
  database: RlsDatabase<Transaction>,
  fence: MembershipFence,
): RlsDatabase<Transaction> =>
  markRlsDatabase({
    transaction: async <T>(fn: (tx: Transaction) => Promise<T>) =>
      await database.transaction(async (tx) => {
        await fence.assert(tx);
        return await fn(tx);
      }),
  });

export type ReviewResetOptions = {
  config: ReviewOrganizationConfig | null;
  /** Owner connection: the target proof, enumeration and matter teardown. */
  db: SchedulerDb;
  /** Application-role connection the review account's own writes run on. */
  rlsDatabase?: RlsDatabase<Transaction> | undefined;
  /** The scheduler run, stamped on every audit row the reset writes. */
  runId: SafeId<"schedulerJobRun">;
  signal: AbortSignal;
  dependencies?: ReviewResetDependencies | undefined;
};

const failureReason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The review account acting in its organization, for one reset run. */
type ResetScope = {
  target: ReviewTarget;
  db: SchedulerDb;
  safeDb: SafeDb;
  fence: MembershipFence;
  signal: AbortSignal;
  recorderFor: (workspaceId: SafeId<"workspace"> | null) => AuditRecorder;
  /** The recorder for organization-level rows. */
  recordOrganizationAuditEvent: AuditRecorder;
  subject: SafeId<"schedulerJobRun">;
  dependencies: ReviewResetDependencies;
};

/** Delete each row through `remove`, tallying deletions and failures. */
const deleteEach = async <TRow extends { id: string }>(
  scope: ResetScope,
  kind: ReviewResetKind,
  read: BoundedReadResult<TRow>,
  remove: (row: TRow) => Promise<Result<unknown, unknown>>,
): Promise<{ deleted: number; failures: ReviewResetFailure[] }> => {
  // Each kind reads at most its organization cap; more rows than the cap
  // can hold means the organization is not in a state the reset knows.
  if (read.type === "overflow") {
    return {
      deleted: 0,
      failures: [
        {
          kind,
          id: scope.target.organizationId,
          reason: `more than ${read.cap} rows; none were deleted`,
        },
      ],
    };
  }
  let deleted = 0;
  const failures: ReviewResetFailure[] = [];
  // Every row goes through its kind's shared delete path, one short
  // transaction each; a failed row is reported and the next one still runs.
  const settled = await inOrder(read.rows, async (row) => {
    if (scope.signal.aborted || scope.fence.tripped) {
      return Result.ok(undefined);
    }
    const outcome = await remove(row);
    if (Result.isError(outcome)) {
      failures.push({ kind, id: row.id, reason: failureReason(outcome.error) });
    } else {
      deleted += 1;
    }
    return Result.ok(undefined);
  });
  settled.unwrap("Row failures are reported, never returned");
  return { deleted, failures };
};

const deleteMatters = async (scope: ResetScope) => {
  const { organizationId, userId } = scope.target;
  // Bounded by the organization's matter cap, as every enumeration below is
  // bounded by its own kind's cap.
  const rows = await readBounded(
    scope.db
      .select({ id: workspaces.id, status: workspaces.status })
      .from(workspaces)
      .where(eq(workspaces.organizationId, organizationId))
      .orderBy(asc(workspaces.id)),
    LIMITS.workspacesCount,
  );
  return await deleteEach(scope, "matters", rows, async (matter) => {
    if (matter.status === "archived") {
      const unarchived = await Result.gen(() =>
        unarchiveWorkspaceHandler({
          safeDb: scope.safeDb,
          workspaceId: matter.id,
          recordAuditEvent: scope.recorderFor(matter.id),
        }),
      );
      if (Result.isError(unarchived)) {
        return unarchived;
      }
    }
    const outcome = await executeAuthorizedWorkspaceDeletion(
      {
        actorUserId: userId,
        organizationId,
        recordAuditEvent: scope.recorderFor(matter.id),
        workspaceId: matter.id,
      },
      {
        ...scope.dependencies.workspaceDeletion,
        database: {
          transaction: async (callback) =>
            await scope.db.transaction(async (tx) => {
              await scope.fence.assert(tx);
              return await callback(tx);
            }),
        },
      },
    );
    return Result.isOk(outcome) && outcome.value.status !== "deleted"
      ? Result.err(outcome.value.status)
      : outcome;
  });
};

const deleteContacts = async (scope: ResetScope) => {
  const { organizationId } = scope.target;
  const rows = await readBounded(
    scope.db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.organizationId, organizationId))
      .orderBy(asc(contacts.id)),
    LIMITS.contactsCount,
  );
  return await deleteEach(
    scope,
    "contacts",
    rows,
    async (contact) =>
      await Result.gen(() =>
        deleteContactHandler({
          safeDb: scope.safeDb,
          organizationId,
          contactId: contact.id,
          recordAuditEvent: scope.recorderFor(null),
        }),
      ),
  );
};

const deleteClauses = async (scope: ResetScope) => {
  const { organizationId } = scope.target;
  const rows = await readBounded(
    scope.db
      .select({ id: clauses.id })
      .from(clauses)
      .where(eq(clauses.organizationId, organizationId))
      .orderBy(asc(clauses.id)),
    LIMITS.clausesPerOrganization,
  );
  return await deleteEach(
    scope,
    "clauses",
    rows,
    async (clause) =>
      await Result.gen(() =>
        deleteClauseHandler({
          safeDb: scope.safeDb,
          organizationId,
          clauseId: clause.id,
          recordAuditEvent: scope.recorderFor(null),
        }),
      ),
  );
};

const deleteTemplates = async (scope: ResetScope) => {
  const { organizationId } = scope.target;
  const rows = await readBounded(
    scope.db
      .select({ id: templates.id })
      .from(templates)
      .where(eq(templates.organizationId, organizationId))
      .orderBy(asc(templates.id)),
    LIMITS.templatesCount,
  );
  return await deleteEach(
    scope,
    "templates",
    rows,
    async (template) =>
      await Result.gen(() =>
        deleteTemplateHandler({
          safeDb: scope.safeDb,
          organizationId,
          templateId: template.id,
          recordAuditEvent: scope.recorderFor(null),
        }),
      ),
  );
};

const deletePlaybooks = async (scope: ResetScope) => {
  const { organizationId } = scope.target;
  const rows = await readBounded(
    scope.db
      .select({ id: playbookDefinitions.id, name: playbookDefinitions.name })
      .from(playbookDefinitions)
      .where(eq(playbookDefinitions.organizationId, organizationId))
      .orderBy(asc(playbookDefinitions.id)),
    LIMITS.playbookDefinitionsCount,
  );
  const { recordOrganizationAuditEvent } = scope;
  // One playbook and its audit row per transaction, as the playbook delete
  // route writes them.
  return await deleteEach(
    scope,
    "playbooks",
    rows,
    async (playbook) =>
      await scope.safeDb(async (tx) => {
        await tx
          .delete(playbookDefinitions)
          .where(
            and(
              eq(playbookDefinitions.id, playbook.id),
              eq(playbookDefinitions.organizationId, organizationId),
            ),
          );
        await recordOrganizationAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.PLAYBOOK,
          resourceId: playbook.id,
          changes: { deleted: { old: { name: playbook.name }, new: null } },
        });
      }),
  );
};

/**
 * Empty every remaining organization-scoped table (see `reset-scope.ts`) in
 * one owner transaction. The organization's storage erasure is recorded first,
 * exactly as an organization deletion records it, so no object loses the row
 * that names it; the cleanup workers erase the objects after the commit.
 */
const sweepRemainingRows = async (
  scope: ResetScope,
): Promise<{
  swept: ReadonlyMap<string, number>;
  failures: ReviewResetFailure[];
}> => {
  const { organizationId } = scope.target;
  if (scope.fence.tripped) {
    return { swept: new Map(), failures: [] };
  }
  await scope.dependencies.beforeSweep?.();
  // A cancelled run deletes nothing more: checked before the sweep starts and
  // again under its lock, before the storage census or any delete.
  if (scope.signal.aborted) {
    return { swept: new Map(), failures: [] };
  }
  const outcome = await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(scope.db, async (tx) => {
        await scope.fence.assert(tx);
        if (scope.signal.aborted) {
          abortTransaction(
            new ReviewSweepBlockedError({
              message: "The reset was cancelled; the sweep did not run",
            }),
          );
        }
        // The storage census seals and records every matter still standing,
        // and a matter that survives must keep its objects. Counted under the
        // organization-row lock: a matter insert checks its foreign key to
        // that row, so none can appear between this count and the commit.
        const remainingMatters = await tx.$count(
          workspaces,
          eq(workspaces.organizationId, organizationId),
        );
        if (remainingMatters > 0) {
          abortTransaction(
            new ReviewSweepBlockedError({
              message: `${remainingMatters} matter(s) remain; the sweep did not run`,
            }),
          );
        }
        const teardown = await recordOrganizationStorageTeardown({
          organizationId,
          tx,
        });
        const removed = await sweepReviewOrganization({
          tx,
          organizationId,
          subject: scope.subject,
        });
        return { removed, requestIds: teardown.requestIds };
      }),
    catch: (cause) => cause,
  });
  if (Result.isError(outcome)) {
    return {
      swept: new Map(),
      failures: [
        {
          kind: "sweep",
          id: organizationId,
          reason: failureReason(outcome.error),
        },
      ],
    };
  }
  await handoffCommittedEntityDeletionCleanupBatch({
    captureDeliveryError: captureError,
    enqueueCleanup:
      scope.dependencies.workspaceDeletion?.enqueueCleanup ??
      enqueueEntityDeletionCleanup,
    requestIds: outcome.value.requestIds,
  });
  return { swept: outcome.value.removed, failures: [] };
};

/**
 * Delete everything the review organization holds and seed it again. Refuses
 * (see `resolveReviewTarget`) unless the configured organization is the
 * restricted review organization. Each row goes through the same delete path
 * a member request takes, recorded in the organization's audit log with this
 * run as its source; a row that cannot be deleted is reported, not skipped
 * silently, and the seed still runs so the sample data is complete.
 */
export const resetReviewOrganization = async ({
  config,
  db,
  rlsDatabase,
  runId,
  signal,
  dependencies = {},
}: ReviewResetOptions): Promise<
  Result<ReviewResetReport, ReviewResetRefusedError>
> => {
  const target = await resolveReviewTarget(config, db);
  if (Result.isError(target)) {
    return target;
  }
  const { organizationId, userId } = target.value;
  const recorderFor = (
    workspaceId: SafeId<"workspace"> | null,
  ): AuditRecorder =>
    createBackgroundAuditRecorder({
      organizationId,
      workspaceId,
      userId,
      execution: {
        performer: {
          type: "service",
          id: "review-organization-reset",
          name: "Review organization reset",
        },
        trigger: {
          type: "schedule",
          ownerUserId: userId,
          source: "scheduler",
          sourceId: runId,
        },
      },
    });
  const fence = createMembershipFence(
    target.value,
    dependencies.afterFenceCheck,
  );
  const fencedDatabase =
    rlsDatabase === undefined
      ? createFencedRlsDatabase(fence.assert)
      : fencedRlsDatabase(rlsDatabase, fence);
  const scope: ResetScope = {
    target: target.value,
    db,
    safeDb: createRootMembershipSafeDb(
      { organizationId, userId },
      fencedDatabase,
    ),
    fence,
    signal,
    recorderFor,
    recordOrganizationAuditEvent: recorderFor(null),
    dependencies,
    subject: runId,
  };

  await dependencies.afterTargetResolved?.();
  // Matters first: their documents, tasks and time entries go with them, and
  // a contact that is a matter's client cannot be deleted before it.
  const matters = await deleteMatters(scope);
  const contactsOutcome = await deleteContacts(scope);
  const clausesOutcome = await deleteClauses(scope);
  const templatesOutcome = await deleteTemplates(scope);
  const playbooks = await deletePlaybooks(scope);
  const deleted = {
    matters: matters.deleted,
    contacts: contactsOutcome.deleted,
    clauses: clausesOutcome.deleted,
    templates: templatesOutcome.deleted,
    playbooks: playbooks.deleted,
  };
  const sweep = await sweepRemainingRows(scope);
  const failures = [
    ...matters.failures,
    ...contactsOutcome.failures,
    ...clausesOutcome.failures,
    ...templatesOutcome.failures,
    ...playbooks.failures,
    ...sweep.failures,
  ];
  const { swept } = sweep;

  if (fence.tripped) {
    return refuse(
      REVIEW_RESET_REFUSAL.otherMembers,
      "The review organization gained a member during the reset; it stopped",
    );
  }
  if (signal.aborted) {
    return Result.ok({
      deleted,
      swept,
      failures,
      seed: Result.err(
        new ReviewSeedError({
          message: "The reset was cancelled before the seed",
          item: "all",
          cause: signal.reason,
        }),
      ),
    });
  }
  const seed = await seedReviewOrganization(
    {
      organizationId,
      userId,
      userEmail: target.value.email,
      // Built here, where the account's sole membership was just proved.
      memberAuthority: sessionMemberRole(target.value.role),
      safeDb: scope.safeDb,
      scopedDb: createRootMembershipScopedDb(
        { organizationId, userId },
        fencedDatabase,
      ),
      recorderFor,
      cancelled: seedCancellation(signal),
    },
    dependencies.seed,
  );

  return Result.ok({ deleted, swept, failures, seed });
};
