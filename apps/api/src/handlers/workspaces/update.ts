import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  MATTER_REFERENCE_RETIRED_CODE,
  MATTER_VISIBILITY,
  widensMatterVisibility,
} from "@stll/api-contract";
import type { MatterVisibility } from "@stll/api-contract";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  contacts,
  documentReferenceCounters,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { workspaceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { captureError } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { checkDemoAccountOperation } from "@/api/lib/auth/demo-account";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { hasManagementPermission } from "@/api/lib/permission-authorization";
import { PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-queue";
import {
  hasUsableSteward,
  tMatterVisibility,
} from "@/api/lib/workspaces/visibility";

const updateWorkspaceBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  clientId: t.Optional(tSafeId("contact")),
  reference: t.Optional(t.String({ maxLength: 64, minLength: 1 })),
  billingReference: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
  color: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  // Pinned-first avatar on the matters list. Must be an existing
  // workspace member (validated at handler time); pass null to clear.
  // Only the current lead or an organization owner/admin may change it.
  leadUserId: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
  // Who can see the matter. Only the matter lead or an organization
  // owner/admin may change it, and every change is audited.
  visibility: t.Optional(tMatterVisibility()),
  // Attaches a client to a matter that has none, optionally adding
  // members in the same write. It does not change who can see the
  // matter; `visibility` alone decides that.
  promote: t.Optional(
    t.Object({
      clientId: tSafeId("contact"),
      memberUserIds: t.Optional(
        t.Array(t.String({ maxLength: 128 }), {
          maxItems: LIMITS.workspaceMembersCount - 1,
        }),
      ),
    }),
  ),
});

const config = {
  contract: "patch",
  description:
    "Change a matter: its name, reference, billing reference, colour, or " +
    "lead (who must already be a member of it). Only the fields you pass are " +
    "written. Attaching a client to a personal matter is a one-way promotion " +
    "and must go through promote, which takes the client contact and " +
    "optionally the members to share it with at the same time; a bare " +
    "clientId on a personal matter, and any attempt to re-promote a matter " +
    "that already has a client, are refused. visibility decides who can " +
    "see the matter, independent of its client: all_members (every internal " +
    "member), admins_and_assigned (owners, admins and assigned members) or " +
    "assigned_only (assigned members only, at least one). Only the matter " +
    "lead or an organization owner or admin may change the visibility or " +
    "the lead.",
  permissions: { workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: workspaceRealtimeUpdates,
  mcp: { type: "covered", by: "save_matter" },
  body: updateWorkspaceBodySchema,
} satisfies WorkspaceHandlerConfig;

type LeadValidationFailure = {
  ok: false;
  status: 400;
  message: "Lead must be a workspace member";
};

const validateLeadIsMember = async (
  tx: Transaction,
  leadUserId: string | null | undefined,
  workspaceId: SafeId<"workspace">,
  requestedMemberUserIds: readonly string[] = [],
): Promise<LeadValidationFailure | null> => {
  if (leadUserId === undefined || leadUserId === null) {
    return null;
  }
  const existing = await tx
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, leadUserId),
      ),
    )
    .limit(1);
  if (existing.length === 0 && !requestedMemberUserIds.includes(leadUserId)) {
    return {
      ok: false,
      status: 400,
      message: "Lead must be a workspace member",
    };
  }
  return null;
};

type RetiredReferenceCheckOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  reference: string;
};

type RetiredReferenceFailure = {
  ok: false;
  status: 409;
  code: typeof MATTER_REFERENCE_RETIRED_CODE;
  message: string;
};

/**
 * Refuse a reference another matter has already numbered documents under.
 *
 * Those stamps are printed inside files that cannot be reissued, so the
 * reference names that matter permanently. A null owner is a deleted matter:
 * the ledger row outlives it precisely so the reference stays retired instead
 * of looking free. The matter that owns the reference may always return to it.
 */
const checkReferenceNotRetired = async ({
  tx,
  organizationId,
  workspaceId,
  reference,
}: RetiredReferenceCheckOptions): Promise<RetiredReferenceFailure | null> => {
  const ledgerRows = await tx
    .select({
      lastValue: documentReferenceCounters.lastValue,
      workspaceId: documentReferenceCounters.workspaceId,
    })
    .from(documentReferenceCounters)
    .where(
      and(
        eq(documentReferenceCounters.organizationId, organizationId),
        eq(documentReferenceCounters.reference, reference),
      ),
    )
    .limit(1)
    .for("update");

  const ledger = ledgerRows.at(0);
  if (!ledger || ledger.lastValue === 0 || ledger.workspaceId === workspaceId) {
    return null;
  }

  return {
    ok: false,
    status: 409,
    code: MATTER_REFERENCE_RETIRED_CODE,
    message:
      "Documents have already been numbered under this reference, so it " +
      "belongs to the matter that numbered them and cannot be reused.",
  };
};

/**
 * Who is changing the matter, as far as its visibility and lead are
 * concerned. An organization owner or admin may change them on any matter
 * they can reach; anyone else only on a matter they lead.
 */
export type WorkspaceUpdateActor = {
  userId: SafeId<"user">;
  managesOrganizationMatters: boolean;
};

type StewardshipFailure = {
  ok: false;
  status: 403;
  message: "Only the matter lead or an organization admin can change who can see or lead this matter";
};

/**
 * Visibility and lead are the matter's stewardship: only its current lead (as
 * stored before this request, so naming yourself lead in the same request
 * does not count) or an organization owner/admin may change them.
 */
const checkStewardship = (
  actor: WorkspaceUpdateActor,
  currentLeadUserId: string | null,
): StewardshipFailure | null =>
  actor.managesOrganizationMatters || currentLeadUserId === actor.userId
    ? null
    : {
        ok: false,
        status: 403,
        message:
          "Only the matter lead or an organization admin can change who can see or lead this matter",
      };

/** Refuse a visibility change the actor may not make. */
const checkVisibilityChange = ({
  actor,
  currentLeadUserId,
}: {
  actor: WorkspaceUpdateActor;
  currentLeadUserId: string | null;
}): StewardshipFailure | null => checkStewardship(actor, currentLeadUserId);

type StewardFailure = {
  ok: false;
  status: 400;
  message: "A matter visible to assigned members only needs a lead who is an internal member assigned to it";
};

/**
 * The resulting matter, not the request, must keep the steward invariant: an
 * assigned-only matter always has a usable lead. Checked whenever the lead or
 * the visibility changes.
 */
const checkResultingSteward = async ({
  tx,
  organizationId,
  workspaceId,
  current,
  next,
  assigningUserIds,
}: {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  current: { leadUserId: string | null; visibility: MatterVisibility };
  next: {
    leadUserId: string | null | undefined;
    visibility: MatterVisibility | undefined;
  };
  assigningUserIds: readonly string[];
}): Promise<StewardFailure | null> => {
  const leadUserId =
    next.leadUserId === undefined ? current.leadUserId : next.leadUserId;
  const visibility = next.visibility ?? current.visibility;
  const changed =
    leadUserId !== current.leadUserId || visibility !== current.visibility;
  if (!changed || visibility !== MATTER_VISIBILITY.assignedOnly) {
    return null;
  }
  return (await hasUsableSteward(tx, {
    organizationId,
    workspaceId,
    leadUserId,
    assigningUserIds,
  }))
    ? null
    : {
        ok: false,
        status: 400,
        message:
          "A matter visible to assigned members only needs a lead who is an internal member assigned to it",
      };
};

export type UpdateWorkspaceHandlerProps = {
  actor: WorkspaceUpdateActor;
  userEmail: string;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof updateWorkspaceBodySchema>;
};

// Shared matter-update logic reused by the HTTP handler and the
// `save_matter` MCP tool, so both emit identical audit events and
// search-index writes.
export const updateWorkspaceHandler = async function* ({
  actor,
  userEmail,
  safeDb,
  organizationId,
  workspaceId,
  recordAuditEvent,
  body,
}: UpdateWorkspaceHandlerProps) {
  if ((body.promote?.memberUserIds?.length ?? 0) > 0) {
    yield* checkDemoAccountOperation(userEmail);
  }
  const txResult = await safeDb(async (tx) => {
    const workspaceRows = await tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        clientId: workspaces.clientId,
        reference: workspaces.reference,
        billingReference: workspaces.billingReference,
        color: workspaces.color,
        leadUserId: workspaces.leadUserId,
        visibility: workspaces.visibility,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .for("update");
    const workspace = workspaceRows.at(0);

    if (!workspace) {
      return {
        ok: false as const,
        status: 404 as const,
        message: "Workspace not found",
      };
    }

    // Promotion is only valid for personal matters (clientId IS
    // NULL). Reject any attempt to "re-promote" a client matter so
    // the call site does not silently overwrite the existing
    // client + member set.
    if (body.promote && workspace.clientId !== null) {
      return {
        ok: false as const,
        status: 400 as const,
        message: "Workspace is already a client matter",
      };
    }

    // Bare clientId on a personal matter is conceptually a
    // promotion we want to be explicit about. Force callers to
    // use `promote` for personal -> client.
    if (body.clientId && workspace.clientId === null) {
      return {
        ok: false as const,
        status: 400 as const,
        message: "Use promote to attach a client to a personal matter",
      };
    }

    const promotionClientId = body.promote?.clientId ?? body.clientId;
    if (promotionClientId) {
      const client = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, promotionClientId),
            eq(contacts.organizationId, organizationId),
          ),
        )
        .for("update")
        .limit(1)
        .then((rows) => rows.at(0) ?? null);

      if (!client) {
        return {
          ok: false as const,
          status: 404 as const,
          message: "Client not found",
        };
      }
    }

    const requestedMemberUserIds = body.promote?.memberUserIds
      ? Array.from(new Set(body.promote.memberUserIds))
      : [];

    if (requestedMemberUserIds.length > 0) {
      const orgMembers = await tx
        .select({ userId: member.userId })
        .from(member)
        .where(
          and(
            eq(member.organizationId, organizationId),
            inArray(member.userId, requestedMemberUserIds),
          ),
        )
        .for("update");

      if (orgMembers.length !== requestedMemberUserIds.length) {
        return {
          ok: false as const,
          status: 400 as const,
          message: "Some users are not members of this organization",
        };
      }
    }

    const promotionUpdate = body.promote
      ? { clientId: body.promote.clientId }
      : {};

    // Lead must be a member of the workspace. Accept both pre-existing
    // members and any added in this same call (promotion path) so the
    // caller can promote + add team + set lead atomically.
    const leadCheck = await validateLeadIsMember(
      tx,
      body.leadUserId,
      workspaceId,
      requestedMemberUserIds,
    );
    if (leadCheck) {
      return leadCheck;
    }

    if (
      body.leadUserId !== undefined &&
      body.leadUserId !== workspace.leadUserId
    ) {
      const stewardship = checkStewardship(actor, workspace.leadUserId);
      if (stewardship) {
        return stewardship;
      }
    }

    const visibilityChanged =
      body.visibility !== undefined && body.visibility !== workspace.visibility;
    if (body.visibility !== undefined && visibilityChanged) {
      const visibilityCheck = checkVisibilityChange({
        actor,
        currentLeadUserId: workspace.leadUserId,
      });
      if (visibilityCheck) {
        return visibilityCheck;
      }
    }

    const stewardCheck = await checkResultingSteward({
      tx,
      organizationId,
      workspaceId,
      current: workspace,
      next: { leadUserId: body.leadUserId, visibility: body.visibility },
      assigningUserIds: requestedMemberUserIds,
    });
    if (stewardCheck) {
      return stewardCheck;
    }

    // Before the write, so a reference that is both retired and currently held
    // answers with the specific refusal rather than the unique-violation 409.
    if (
      body.reference !== undefined &&
      body.reference !== workspace.reference
    ) {
      const retired = await checkReferenceNotRetired({
        tx,
        organizationId,
        workspaceId,
        reference: body.reference,
      });
      if (retired) {
        return retired;
      }
    }

    await tx
      .update(workspaces)
      .set({
        ...pickDefined(body, [
          "name",
          "clientId",
          "reference",
          "billingReference",
          "color",
          "leadUserId",
          "visibility",
        ]),
        ...promotionUpdate,
      })
      .where(eq(workspaces.id, workspaceId));

    // Audit reflects rows actually inserted, not the raw request:
    // onConflictDoNothing silently skips users already on the
    // workspace (e.g., the creator on a freshly-promoted personal
    // matter), and we don't want the log to claim they were added.
    let insertedMemberUserIds: string[] = [];
    if (body.promote && requestedMemberUserIds.length > 0) {
      const inserted = await tx
        .insert(workspaceMembers)
        .values(
          requestedMemberUserIds.map((id) => ({
            workspaceId,
            userId: brandPersistedUserId(id),
          })),
        )
        .onConflictDoNothing()
        .returning({ userId: workspaceMembers.userId });
      insertedMemberUserIds = inserted.map((row) => row.userId);
    }

    const newClientId = body.promote?.clientId ?? body.clientId;
    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (body.name !== undefined && body.name !== workspace.name) {
      changes["name"] = { old: workspace.name, new: body.name };
    }
    if (newClientId !== undefined && newClientId !== workspace.clientId) {
      changes["clientId"] = { old: workspace.clientId, new: newClientId };
    }
    if (
      body.reference !== undefined &&
      body.reference !== workspace.reference
    ) {
      changes["reference"] = {
        old: workspace.reference,
        new: body.reference,
      };
    }
    if (
      body.billingReference !== undefined &&
      body.billingReference !== workspace.billingReference
    ) {
      changes["billingReference"] = {
        old: workspace.billingReference,
        new: body.billingReference,
      };
    }
    if (body.color !== undefined && body.color !== workspace.color) {
      changes["color"] = { old: workspace.color, new: body.color };
    }
    if (
      body.leadUserId !== undefined &&
      body.leadUserId !== workspace.leadUserId
    ) {
      changes["leadUserId"] = {
        old: workspace.leadUserId,
        new: body.leadUserId,
      };
    }
    if (insertedMemberUserIds.length > 0) {
      changes["membersAdded"] = {
        old: null,
        new: insertedMemberUserIds,
      };
    }
    if (visibilityChanged) {
      changes["visibility"] = {
        old: workspace.visibility,
        new: body.visibility,
      };
    }

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
      resourceId: workspaceId,
      changes,
      // Widening exposes the matter's contents to people who could not see
      // them before; mark every change so the audit log can be filtered for
      // exactly those events.
      ...(visibilityChanged && body.visibility !== undefined
        ? {
            metadata: {
              visibilityChange: widensMatterVisibility(
                workspace.visibility,
                body.visibility,
              )
                ? "widened"
                : "narrowed",
            },
          }
        : {}),
    });

    await enqueueWorkspaceSearchRepairs(tx, [workspaceId]);

    return { ok: true as const };
  });

  if (Result.isError(txResult)) {
    if (
      DatabaseError.is(txResult.error) &&
      txResult.error.code === PG_ERROR.UNIQUE_VIOLATION
    ) {
      return yield* Result.err(
        new HandlerError({ status: 409, message: "Duplicate value" }),
      );
    }
    return yield* Result.err(txResult.error);
  }

  const failure = txResult.value;
  if (!failure.ok) {
    return yield* Result.err(
      new HandlerError({
        status: failure.status,
        message: failure.message,
        // Only the retired-reference refusal carries a code; the status is its
        // discriminator, so a branch without one cannot reach this spread.
        ...(failure.status === 409 ? { code: failure.code } : {}),
      }),
    );
  }

  flushWorkspaceSearchRepairs([workspaceId]).catch(captureError);

  return Result.ok({});
};

const updateWorkspace = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    return yield* updateWorkspaceHandler({
      actor: {
        userId: user.id,
        managesOrganizationMatters: hasManagementPermission(memberRole, {
          workspace: ["update"],
        }),
      },
      userEmail: user.email,
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default updateWorkspace;
