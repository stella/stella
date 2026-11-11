import { panic, Result } from "better-result";
import { and, desc, eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  CONFLICT_CHECK_REFUSAL_CODE,
  CONFLICT_COVERAGE_GAPS,
  CONFLICT_PARTY_ROLES,
} from "@stll/api-contract/conflict-checks";
import type {
  ConflictCheckDecisionInput,
  ConflictCheckListItem,
  ConflictCheckView,
  ConflictParty,
  ConflictPartyRole,
} from "@stll/api-contract/conflict-checks";

import { member, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import {
  conflictCheckMatters,
  conflictChecks,
  workspaces,
} from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { decisionRefusal } from "@/api/lib/conflict-check/decision";
import { readConflictContactLinks } from "@/api/lib/conflict-check/links";
import { conflictCheckOutcome } from "@/api/lib/conflict-check/outcome";
import { loadContactPartyIndex } from "@/api/lib/conflict-check/party-index";
import { projectConflictCheck } from "@/api/lib/conflict-check/project";
import { screenConflictParty } from "@/api/lib/conflict-check/screen";
import type { PartyScreening } from "@/api/lib/conflict-check/screen";
import type {
  StoredConflictPartyResult,
  StoredConflictResults,
} from "@/api/lib/conflict-check/stored-results";
import { CONFLICT_CHECK_DECISION_TRANSITIONS } from "@/api/lib/conflict-check/transitions";
import { createTimestampIdCursorCodec } from "@/api/lib/db-pagination";
import type { AuditRecorder } from "@/api/lib/db/audit-recording";
import { abortTransaction } from "@/api/lib/db/transaction-abort";
import { transitionScopedBatch } from "@/api/lib/db/transitions";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { createCursorPage } from "@/api/lib/pagination";
import { brandPersistedConflictCheckId } from "@/api/lib/safe-id-boundaries";

const CHECK_COLUMNS = {
  id: conflictChecks.id,
  title: conflictChecks.title,
  runBy: conflictChecks.runBy,
  parties: conflictChecks.parties,
  results: conflictChecks.results,
  outcome: conflictChecks.outcome,
  decision: conflictChecks.decision,
  decidedBy: conflictChecks.decidedBy,
  decidedAt: conflictChecks.decidedAt,
  decisionNote: conflictChecks.decisionNote,
  consentReference: conflictChecks.consentReference,
  createdAt: conflictChecks.createdAt,
} as const;

// Thrown inside a transaction so it aborts; `abortableTx` hands it back.
const checkNotFound = () =>
  new HandlerError({
    status: 404,
    code: "not_found",
    message: "Conflict check not found",
  });

const matterNotFound = () =>
  new HandlerError({
    status: 404,
    code: "not_found",
    message: "Matter not found",
  });

type Organization = { organizationId: SafeId<"organization"> };

type CheckResult<T> = Result<T, HandlerError | SafeDbError>;

const readRow = async (
  tx: Transaction,
  {
    organizationId,
    checkId,
  }: Organization & { checkId: SafeId<"conflictCheck"> },
) => {
  const row = (
    await tx
      .select({
        ...CHECK_COLUMNS,
        workspaceId: conflictCheckMatters.workspaceId,
      })
      .from(conflictChecks)
      .leftJoin(
        conflictCheckMatters,
        eq(conflictCheckMatters.conflictCheckId, conflictChecks.id),
      )
      .where(
        and(
          eq(conflictChecks.organizationId, organizationId),
          eq(conflictChecks.id, checkId),
        ),
      )
      .limit(1)
  ).at(0);
  if (row === undefined) {
    return abortTransaction(checkNotFound());
  }
  return row;
};

const requireOpenableMatter = async (
  tx: Transaction,
  {
    organizationId,
    workspaceId,
  }: Organization & { workspaceId: SafeId<"workspace"> },
) => {
  const found = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.organizationId, organizationId),
        eq(workspaces.id, workspaceId),
      ),
    )
    .limit(1);
  if (found.length === 0) {
    abortTransaction(matterNotFound());
  }
};

type ScreenedParty = { party: ConflictParty; screening: PartyScreening };

/**
 * Every party's matches with their matter links. The links are read once per
 * party role (three at most), each read covering every contact matched for
 * that role.
 */
const storedParties = async ({
  tx,
  organizationId,
  screened,
}: Organization & {
  tx: Transaction;
  screened: readonly ScreenedParty[];
}): Promise<StoredConflictPartyResult[]> => {
  const linksByRole = new Map<
    ConflictPartyRole,
    Awaited<ReturnType<typeof readConflictContactLinks>>
  >();
  for (const partyRole of CONFLICT_PARTY_ROLES) {
    linksByRole.set(
      partyRole,
      await readConflictContactLinks({
        tx,
        organizationId,
        partyRole,
        contactIds: screened
          .filter(({ party }) => party.role === partyRole)
          .flatMap(({ screening }) =>
            screening.matches.map((match) => match.contact.id),
          ),
      }),
    );
  }
  return screened.map(({ party, screening }) => {
    const links =
      linksByRole.get(party.role) ?? panic("Links missing for a party role");
    return {
      hits: screening.matches.map((match) => ({
        contactId: match.contact.id,
        contactName: match.contact.name,
        contactType: match.contact.type,
        tier: match.tier,
        score: match.score,
        matchedName: match.matchedName,
        evidence: match.evidence,
        links:
          links.get(match.contact.id) ??
          panic("Links missing for a matched contact"),
      })),
      totalMatches: screening.totalMatches,
      truncated: screening.truncated,
      incomplete: screening.incomplete,
    };
  });
};

export type RunConflictCheckOptions = Organization & {
  safeDb: SafeDb;
  userId: SafeId<"user">;
  title: string | null;
  parties: ConflictParty[];
  recordAuditEvent: AuditRecorder;
  /** The contact cap; tests pass a small one. */
  contactCap?: number;
};

/**
 * Screens the parties against every contact of the organization, records
 * what was found and how far the search reached, and returns the check as the
 * runner may see it. The address book is read in one short transaction and
 * matched outside it; the matter links, the record and its audit entry are
 * written together.
 */
export const runConflictCheck = async ({
  safeDb,
  organizationId,
  userId,
  title,
  parties,
  recordAuditEvent,
  contactCap,
}: RunConflictCheckOptions): Promise<CheckResult<ConflictCheckView>> => {
  const loaded = await safeDb(
    async (tx) =>
      await loadContactPartyIndex({
        tx,
        organizationId,
        ...(contactCap === undefined ? {} : { cap: contactCap }),
      }),
  );
  if (loaded.isErr()) {
    return Result.err(loaded.error);
  }
  const { index, screened, overCap } = loaded.value;
  const screenedParties: ScreenedParty[] = [];
  for (const [partyIndex, party] of parties.entries()) {
    const screening = screenConflictParty({ index, party, partyIndex });
    if (screening.isErr()) {
      return Result.err(screening.error);
    }
    screenedParties.push({ party, screening: screening.value });
  }

  return await abortableTx(safeDb, async (tx) => {
    const partyResults = await storedParties({
      tx,
      organizationId,
      screened: screenedParties,
    });
    const results: StoredConflictResults = {
      version: 1,
      contactsScreened: screened,
      gaps: [
        ...(overCap ? [CONFLICT_COVERAGE_GAPS.contactsOverCap] : []),
        ...(partyResults.some((party) => party.incomplete)
          ? [CONFLICT_COVERAGE_GAPS.partyWorkLimit]
          : []),
      ],
      parties: partyResults,
    };
    const outcome = conflictCheckOutcome(results);
    const row =
      (
        await tx
          .insert(conflictChecks)
          .values({
            organizationId,
            title,
            runBy: userId,
            parties,
            results,
            outcome,
          })
          .returning(CHECK_COLUMNS)
      ).at(0) ?? panic("A conflict check insert returned no row");
    // Party names stay out of the audit trail; the check row holds them.
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.CREATE,
      resourceType: AUDIT_RESOURCE_TYPE.CONFLICT_CHECK,
      resourceId: row.id,
      workspaceId: null,
      metadata: {
        outcome,
        partyCount: parties.length,
        hitCount: partyResults.flatMap((party) => party.hits).length,
        contactsScreened: screened,
      },
    });
    return await projectConflictCheck({
      tx,
      organizationId,
      row,
      workspaceId: null,
    });
  });
};

/** One check as this reader may see it; hidden checks read as missing. */
export const readConflictCheck = async ({
  safeDb,
  organizationId,
  checkId,
}: Organization & {
  safeDb: SafeDb;
  checkId: SafeId<"conflictCheck">;
}): Promise<CheckResult<ConflictCheckView>> =>
  await abortableTx(safeDb, async (tx) => {
    const row = await readRow(tx, { organizationId, checkId });
    return await projectConflictCheck({
      tx,
      organizationId,
      row,
      workspaceId: row.workspaceId,
    });
  });

export const conflictCheckCursor = createTimestampIdCursorCodec({
  column: conflictChecks.createdAt,
  brandId: brandPersistedConflictCheckId,
});

/**
 * The checks this reader may see, newest first. Row security decides which:
 * the reader's own, every check for a reviewer, and checks run for a matter
 * the reader may open. The runner's name is read through their membership.
 */
export const listConflictChecks = async ({
  safeDb,
  organizationId,
  limit,
  after,
}: Organization & {
  safeDb: SafeDb;
  limit: number;
  after: SQL | undefined;
}) =>
  await safeDb(async (tx) => {
    const rows = await tx
      .select({
        id: conflictChecks.id,
        title: conflictChecks.title,
        outcome: conflictChecks.outcome,
        decision: conflictChecks.decision,
        parties: conflictChecks.parties,
        createdAt: conflictChecks.createdAt,
        createdAtCursor:
          conflictCheckCursor.cursorValue.as("created_at_cursor"),
        runBy: member.userId,
        runByName: user.name,
        workspaceId: conflictCheckMatters.workspaceId,
      })
      .from(conflictChecks)
      .leftJoin(
        conflictCheckMatters,
        eq(conflictCheckMatters.conflictCheckId, conflictChecks.id),
      )
      .leftJoin(
        member,
        and(
          eq(member.userId, conflictChecks.runBy),
          eq(member.organizationId, organizationId),
        ),
      )
      .leftJoin(user, eq(user.id, member.userId))
      .where(and(eq(conflictChecks.organizationId, organizationId), after))
      .orderBy(desc(conflictChecks.createdAt), desc(conflictChecks.id))
      .limit(limit + 1);
    const page = createCursorPage({
      rows,
      limit,
      cursorForItem: (row) =>
        conflictCheckCursor.encode(row.createdAtCursor, row.id),
    });
    return {
      ...page,
      items: page.items.map((row): ConflictCheckListItem => ({
        id: row.id,
        title: row.title,
        outcome: row.outcome,
        decision: row.decision,
        workspaceId: row.workspaceId,
        createdAt: row.createdAt.toISOString(),
        partyCount: row.parties.length,
        runBy:
          row.runBy === null || row.runByName === null
            ? null
            : { userId: row.runBy, name: row.runByName },
      })),
    };
  });

/** The transition a decision makes; the same decision twice is refused earlier. */
const decisionMove = ({
  decision,
  expectedDecision,
}: ConflictCheckDecisionInput) => {
  switch (decision) {
    case "cleared":
      return expectedDecision === "cleared"
        ? panic("A decision cannot replace itself")
        : ({ to: "cleared", from: [expectedDecision] } as const);
    case "conflict":
      return expectedDecision === "conflict"
        ? panic("A decision cannot replace itself")
        : ({ to: "conflict", from: [expectedDecision] } as const);
    case "waived":
      return expectedDecision === "waived"
        ? panic("A decision cannot replace itself")
        : ({ to: "waived", from: [expectedDecision] } as const);
    default: {
      decision satisfies never;
      return panic("Unhandled conflict check decision");
    }
  }
};

/**
 * Records a person's decision on a check. The decision moves only from the
 * one the caller saw, so two reviewers deciding at once cannot overwrite each
 * other silently.
 */
export const decideConflictCheck = async ({
  safeDb,
  organizationId,
  checkId,
  userId,
  input,
  isReviewer,
  recordAuditEvent,
  now = () => new Date(),
}: Organization & {
  safeDb: SafeDb;
  checkId: SafeId<"conflictCheck">;
  userId: SafeId<"user">;
  input: ConflictCheckDecisionInput;
  isReviewer: boolean;
  recordAuditEvent: AuditRecorder;
  now?: () => Date;
}): Promise<CheckResult<ConflictCheckView>> =>
  await abortableTx(safeDb, async (tx) => {
    const row = await readRow(tx, { organizationId, checkId });
    const refusal = decisionRefusal({
      input,
      outcome: row.outcome,
      isReviewer,
    });
    if (refusal.isErr()) {
      return abortTransaction(refusal.error);
    }
    const decidedAt = now();
    const changed = await transitionScopedBatch({
      tx,
      spec: CONFLICT_CHECK_DECISION_TRANSITIONS,
      identities: [{ id: checkId, organizationId }],
      options: {
        ...decisionMove(input),
        set: {
          decidedBy: userId,
          decidedAt,
          decisionNote: input.note ?? null,
          consentReference: input.consentReference ?? null,
          updatedAt: decidedAt,
        },
      },
      recordTransitionAuditEvent: async (auditTx) => {
        await recordAuditEvent(auditTx, {
          action: AUDIT_ACTION.REVIEW,
          resourceType: AUDIT_RESOURCE_TYPE.CONFLICT_CHECK,
          resourceId: checkId,
          workspaceId: row.workspaceId,
          changes: {
            decision: { old: row.decision, new: input.decision },
          },
        });
      },
    });
    if (changed.length === 0) {
      return abortTransaction(
        new HandlerError({
          status: 409,
          code: CONFLICT_CHECK_REFUSAL_CODE.decisionChanged,
          message: "The check's decision changed since it was read",
          hint: "Read the check again and decide on what it now says.",
        }),
      );
    }
    const updated = await readRow(tx, { organizationId, checkId });
    return await projectConflictCheck({
      tx,
      organizationId,
      row: updated,
      workspaceId: updated.workspaceId,
    });
  });

/** Links a check to the matter it was run for. One matter per check. */
export const linkConflictCheckMatter = async ({
  safeDb,
  organizationId,
  checkId,
  workspaceId,
  recordAuditEvent,
}: Organization & {
  safeDb: SafeDb;
  checkId: SafeId<"conflictCheck">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
}): Promise<CheckResult<ConflictCheckView>> =>
  await abortableTx(safeDb, async (tx) => {
    const row = await readRow(tx, { organizationId, checkId });
    await requireOpenableMatter(tx, { organizationId, workspaceId });
    if (row.workspaceId !== workspaceId) {
      await tx
        .insert(conflictCheckMatters)
        .values({ organizationId, conflictCheckId: checkId, workspaceId })
        .onConflictDoUpdate({
          target: conflictCheckMatters.conflictCheckId,
          set: { workspaceId },
        });
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CONFLICT_CHECK,
        resourceId: checkId,
        workspaceId,
        changes: {
          workspaceId: { old: row.workspaceId, new: workspaceId },
        },
      });
    }
    return await projectConflictCheck({ tx, organizationId, row, workspaceId });
  });
