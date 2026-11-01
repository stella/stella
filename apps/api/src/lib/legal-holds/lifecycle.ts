import { panic, Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { entities, legalHolds, workspaces } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { readLockedLegalHolds } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { LegalHoldRecord } from "./errors";
import { forgetClearHoldTargets, lockLegalHoldOrganization } from "./holds";

type LegalHoldScope =
  | { type: "matter"; workspaceId: SafeId<"workspace"> }
  | {
      type: "entity";
      workspaceId: SafeId<"workspace">;
      entityId: SafeId<"entity">;
    };
type HoldMutationOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  actorId: SafeId<"user">;
  scope: LegalHoldScope;
  reason: string;
  recordAuditEvent: AuditRecorder;
};

const scopeExists = async ({
  tx,
  organizationId,
  scope,
}: Pick<HoldMutationOptions, "tx" | "organizationId" | "scope">) => {
  const rows = await tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, scope.workspaceId),
        eq(workspaces.organizationId, organizationId),
        sql`${workspaces.status} <> 'deleting'`,
      ),
    )
    .limit(1);
  if (rows.length === 0) {
    return false;
  }
  switch (scope.type) {
    case "matter":
      return true;
    case "entity": {
      const matches = await tx
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(
            eq(entities.id, scope.entityId),
            eq(entities.workspaceId, scope.workspaceId),
          ),
        )
        .limit(1);
      return matches.length > 0;
    }
    default:
      scope satisfies never;
      return panic("Unknown legal hold scope");
  }
};

export const placeLegalHold = async (options: HoldMutationOptions) => {
  const { tx, organizationId, actorId, scope, reason, recordAuditEvent } =
    options;
  await lockLegalHoldOrganization({ tx, organizationId });
  forgetClearHoldTargets(tx);
  if (!(await scopeExists(options))) {
    return Result.err(
      new HandlerError({ status: 404, message: "Matter or item not found." }),
    );
  }
  if (!reason.trim()) {
    return Result.err(
      new HandlerError({ status: 400, message: "A reason is required." }),
    );
  }
  const id = createSafeId<"legalHold">();
  const inserted = await tx
    .insert(legalHolds)
    .values({
      id,
      organizationId,
      scopeType: scope.type,
      workspaceId: scope.type === "matter" ? scope.workspaceId : null,
      entityId: scope.type === "entity" ? scope.entityId : null,
      reason: reason.trim(),
      placedBy: actorId,
    })
    .returning();
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.LEGAL_HOLD_PLACED,
    resourceType: AUDIT_RESOURCE_TYPE.LEGAL_HOLD,
    resourceId: id,
    changes: {
      reason: { old: null, new: reason.trim() },
      scope: { old: null, new: scope.type },
    },
  });
  const hold = inserted.at(0) ?? panic("Legal hold insert returned no row");
  return Result.ok(
    new LegalHoldRecord({
      id: hold.id,
      scope: hold.scopeType,
      workspaceId: scope.workspaceId,
      entityId: hold.entityId,
      placedAt: hold.placedAt,
      placedBy: hold.placedBy,
      reason: hold.reason,
    }),
  );
};

type ReleaseHoldOptions = HoldMutationOptions & { holdId: SafeId<"legalHold"> };
export const releaseLegalHold = async (options: ReleaseHoldOptions) => {
  const {
    tx,
    organizationId,
    actorId,
    scope,
    reason,
    recordAuditEvent,
    holdId,
  } = options;
  await lockLegalHoldOrganization({ tx, organizationId });
  forgetClearHoldTargets(tx);
  if (!(await scopeExists(options))) {
    return Result.err(
      new HandlerError({ status: 404, message: "Matter or item not found." }),
    );
  }
  if (!reason.trim()) {
    return Result.err(
      new HandlerError({ status: 400, message: "A reason is required." }),
    );
  }
  const rows = await readLockedLegalHolds({
    tx,
    predicate:
      and(
        eq(legalHolds.id, holdId),
        eq(legalHolds.organizationId, organizationId),
        eq(legalHolds.scopeType, scope.type),
        scope.type === "matter"
          ? eq(legalHolds.workspaceId, scope.workspaceId)
          : eq(legalHolds.entityId, scope.entityId),
      ) ?? panic("Missing release predicate"),
    mode: "update",
  });
  if (rows.length === 0) {
    return Result.err(
      new HandlerError({ status: 404, message: "Legal hold not found." }),
    );
  }
  const changed = await tx
    .update(legalHolds)
    .set({
      releasedBy: actorId,
      releasedAt: sql`now()`,
      releaseReason: reason.trim(),
    })
    .where(and(eq(legalHolds.id, holdId), isNull(legalHolds.releasedAt)))
    .returning({ id: legalHolds.id });
  if (changed.length > 0) {
    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.LEGAL_HOLD_RELEASED,
      resourceType: AUDIT_RESOURCE_TYPE.LEGAL_HOLD,
      resourceId: holdId,
      changes: {
        releaseReason: { old: null, new: reason.trim() },
        status: { old: "active", new: "released" },
      },
    });
  }
  return Result.ok({ id: holdId, status: "released" as const });
};
