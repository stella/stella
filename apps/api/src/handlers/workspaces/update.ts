import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import {
  MATTER_REFERENCE_RETIRED_CODE,
  MATTER_VISIBILITY,
  widensMatterVisibility,
} from "@stll/api-contract";
import type { MatterVisibility } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  contacts,
  documentReferenceCounters,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { workspaceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { createErrorCapture } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  defaultVarcharSchema,
  resourceIdSchema,
  userIdSchema,
} from "@/api/lib/custom-schema";
import { lockMatterStewardship } from "@/api/lib/db/aggregate-lock";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { hasManagementPermission } from "@/api/lib/permission-authorization";
import { PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-queue";
import {
  hasUsableSteward,
  matterVisibilitySchema,
  readMatterMutationAuthority,
} from "@/api/lib/workspaces/visibility";

const updateWorkspaceBodySchema = v.object({
  name: v.optional(defaultVarcharSchema),
  clientId: v.optional(resourceIdSchema("contact")),
  reference: v.optional(v.pipe(v.string(), v.maxLength(64), v.minLength(1))),
  billingReference: v.optional(
    v.nullable(v.pipe(v.string(), v.maxLength(128))),
  ),
  color: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(32)))),
  leadUserId: v.optional(v.nullable(userIdSchema)),
  visibility: v.optional(matterVisibilitySchema()),
});

const config = {
  contract: "patch",
  description:
    "Change a matter: its name, client, reference, billing reference, colour, " +
    "lead (who must already be a member of it) or visibility. Only the fields " +
    "you pass are written. clientId attaches a client to a matter or replaces " +
    "its client; members are managed separately, and the client does not " +
    "decide who can see the matter. visibility does: all_members (every " +
    "internal member), admins_and_assigned (owners, admins and assigned " +
    "members) or assigned_only (assigned members only, led by an assigned " +
    "internal member). Only the matter lead or an organization owner or admin " +
    "may change the visibility or the lead.",
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
  if (existing.length === 0) {
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

/** Refuse a client that is not a contact of this organization. */
const checkClientExists = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  clientId: SafeId<"contact"> | undefined,
) => {
  if (clientId === undefined) {
    return null;
  }
  const client = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(
      and(
        eq(contacts.id, clientId),
        eq(contacts.organizationId, organizationId),
      ),
    )
    .for("update")
    .limit(1)
    .then((rows) => rows.at(0) ?? null);
  return client
    ? null
    : { ok: false as const, status: 404 as const, message: "Client not found" };
};

/**
 * Lead and visibility are the matter's stewardship: check who may change
 * them, then that the resulting matter keeps a usable steward. An update adds
 * no members, so the steward must already be assigned.
 */
const checkStewardshipChanges = async ({
  tx,
  actor,
  organizationId,
  workspaceId,
  workspace,
  body,
  visibilityChanged,
}: {
  tx: Transaction;
  actor: WorkspaceUpdateActor;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  workspace: { leadUserId: string | null; visibility: MatterVisibility };
  body: Pick<UpdateWorkspaceHandlerProps["body"], "leadUserId" | "visibility">;
  visibilityChanged: boolean;
}): Promise<StewardshipFailure | StewardFailure | null> => {
  if (
    body.leadUserId !== undefined &&
    body.leadUserId !== workspace.leadUserId
  ) {
    const stewardship = checkStewardship(actor, workspace.leadUserId);
    if (stewardship) {
      return stewardship;
    }
  }
  if (visibilityChanged) {
    const visibilityCheck = checkVisibilityChange({
      actor,
      currentLeadUserId: workspace.leadUserId,
    });
    if (visibilityCheck) {
      return visibilityCheck;
    }
  }
  return await checkResultingSteward({
    tx,
    organizationId,
    workspaceId,
    current: workspace,
    next: { leadUserId: body.leadUserId, visibility: body.visibility },
    assigningUserIds: [],
  });
};

export type UpdateWorkspaceHandlerProps = {
  actor: WorkspaceUpdateActor;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: v.InferOutput<typeof updateWorkspaceBodySchema>;
};

/** Lock the complete scope before deciding current reach and reading the row. */
const readLockedWorkspace = async (
  tx: Transaction,
  {
    actor,
    organizationId,
    workspaceId,
    body,
  }: Omit<UpdateWorkspaceHandlerProps, "safeDb" | "recordAuditEvent">,
) => {
  await lockMatterStewardship({
    tx,
    requests: [
      {
        organizationId,
        workspaceIds: [workspaceId],
        userIds: [actor.userId, ...(body.leadUserId ? [body.leadUserId] : [])],
      },
    ],
    mode: "update",
  });
  const authority = await readMatterMutationAuthority(tx, {
    permissions: config.permissions,
    organizationId,
    workspaceId,
    userId: actor.userId,
  });
  if (!authority) {
    return null;
  }
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

  return workspace ? { workspace, authority } : null;
};

// Shared matter-update logic reused by the HTTP handler and the
// `save_matter` MCP tool, so both emit identical audit events and
// search-index writes.
export const updateWorkspaceHandler = async function* ({
  actor,
  safeDb,
  organizationId,
  workspaceId,
  recordAuditEvent,
  body,
}: UpdateWorkspaceHandlerProps) {
  const txResult = await safeDb(async (tx) => {
    const locked = await readLockedWorkspace(tx, {
      actor,
      organizationId,
      workspaceId,
      body,
    });
    if (!locked) {
      return {
        ok: false as const,
        status: 404 as const,
        message: "Workspace not found",
      };
    }
    const { workspace, authority } = locked;

    const clientCheck = await checkClientExists(
      tx,
      organizationId,
      body.clientId,
    );
    if (clientCheck) {
      return clientCheck;
    }

    const leadCheck = await validateLeadIsMember(
      tx,
      body.leadUserId,
      workspaceId,
    );
    if (leadCheck) {
      return leadCheck;
    }

    const visibilityChanged =
      body.visibility !== undefined && body.visibility !== workspace.visibility;
    const stewardshipCheck = await checkStewardshipChanges({
      tx,
      actor: {
        userId: actor.userId,
        managesOrganizationMatters:
          actor.managesOrganizationMatters &&
          authority.managesOrganizationMatters,
      },
      organizationId,
      workspaceId,
      workspace,
      body,
      visibilityChanged,
    });
    if (stewardshipCheck) {
      return stewardshipCheck;
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
      })
      .where(eq(workspaces.id, workspaceId));

    const changes: Record<string, { old: unknown; new: unknown }> = {};
    if (body.name !== undefined && body.name !== workspace.name) {
      changes["name"] = { old: workspace.name, new: body.name };
    }
    if (body.clientId !== undefined && body.clientId !== workspace.clientId) {
      changes["clientId"] = { old: workspace.clientId, new: body.clientId };
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

  flushWorkspaceSearchRepairs([workspaceId]).catch(
    createErrorCapture(
      handlerErrorContext("updateWorkspaceHandler.flushWorkspaceSearchRepairs"),
    ),
  );

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
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default updateWorkspace;
