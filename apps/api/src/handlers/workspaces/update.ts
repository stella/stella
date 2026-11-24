import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import {
  API_VERSION_CONFLICT_ERROR_CODE,
  MATTER_REFERENCE_RETIRED_CODE,
} from "@stll/api-contract";
import {
  effectiveMatterVisibility,
  MATTER_VISIBILITY_WIDENING_UNCONFIRMED_CODE,
  widensMatterVisibility,
} from "@stll/api-contract/matter-visibility";
import type { MatterVisibility } from "@stll/api-contract/matter-visibility";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { abortTransaction, transactionAbortError } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import {
  contacts,
  documentReferenceCounters,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { workspaceRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { createErrorCapture, detached } from "@/api/lib/analytics/capture";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { narrativeLanguageSchema } from "@/api/lib/billing/narrative-language";
import type { SafeId } from "@/api/lib/branded-types";
import {
  displayNameSchema,
  resourceIdSchema,
  userIdSchema,
} from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { databaseConstraintRefusal } from "@/api/lib/db/constraint-refusals";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { isMemberRole } from "@/api/lib/member-roles";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import {
  hasManagementPermission,
  hasMemberPermission,
  withCurrentMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import { PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";
import { requireNoHold } from "@/api/lib/workspaces/legal-holds/holds";
import { legalHoldRefusal } from "@/api/lib/workspaces/legal-holds/refusal";
import { matterVisibilitySchema } from "@/api/lib/workspaces/matter-visibility";

const updateWorkspaceBodySchema = v.object({
  billingNarrativeLanguage: v.optional(narrativeLanguageSchema),
  name: v.optional(displayNameSchema()),
  clientId: v.optional(resourceIdSchema("contact")),
  expectedClientId: v.optional(v.nullable(resourceIdSchema("contact"))),
  reference: v.optional(v.pipe(v.string(), v.maxLength(64), v.minLength(1))),
  billingReference: v.optional(
    v.nullable(v.pipe(v.string(), v.maxLength(128))),
  ),
  color: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(32)))),
  documentNamingEnabled: v.optional(
    v.pipe(
      v.boolean(),
      v.description(
        "Rename new uploads in this matter to the organization's document name pattern.",
      ),
    ),
  ),
  leadUserId: v.optional(v.nullable(userIdSchema)),
  visibility: v.optional(matterVisibilitySchema()),
  confirmWidening: v.optional(
    v.pipe(
      v.literal(true),
      v.description(
        "Required with a visibility that shows the matter to people who " +
          "cannot see it now; confirm with the user first.",
      ),
    ),
  ),
});

const config = {
  contract: "patch",
  description:
    "Change a matter: its name, client, reference, billing reference, the " +
    "language its billing narratives are written in, colour, automatic " +
    "document naming, lead (who must already be a member of it) or " +
    "visibility. Only the fields you pass are written. clientId attaches or " +
    "replaces the matter's client and never changes who can see it; members " +
    "are managed separately. Only the matter lead or an organization owner " +
    "or admin may change the lead or the visibility; widening it needs confirmWidening, " +
    `otherwise returns ${MATTER_VISIBILITY_WIDENING_UNCONFIRMED_CODE}. ` +
    "Pass expectedClientId (null when it has no client) to change the client " +
    `only if its current assignment still matches; otherwise returns ${API_VERSION_CONFLICT_ERROR_CODE}.`,
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

/** Who is changing the matter: the person and the request's authority. */
export type WorkspaceUpdateActor = {
  userId: SafeId<"user">;
  authority: AuthorizedMemberRole;
};

const UPDATE_PERMISSION = { workspace: ["update"] } as const;

type CurrentAuthorityOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  actor: WorkspaceUpdateActor;
};

/**
 * The actor's authority now: the request's credential over the member's
 * current role, read after the matter lock and only while the member still
 * reaches the matter and may still update it. A request admitted before a
 * visibility narrowing or a role change committed keeps no write access
 * through that earlier admission.
 */
const readCurrentUpdateAuthority = async ({
  tx,
  organizationId,
  workspaceId,
  actor,
}: CurrentAuthorityOptions) => {
  const rows = await tx
    .select({ role: member.role, billingAccess: member.billingAccess })
    .from(member)
    .where(
      and(
        eq(member.organizationId, organizationId),
        eq(member.userId, actor.userId),
        memberReachesMatterSql(
          { organizationId, userId: actor.userId },
          workspaceId,
        ),
      ),
    )
    .limit(1);
  const current = rows.at(0);
  if (current === undefined || !isMemberRole(current.role)) {
    return null;
  }
  const authority = withCurrentMemberRole({
    authority: actor.authority,
    role: current.role,
    billingAccess: current.billingAccess,
  });
  return hasMemberPermission(authority, UPDATE_PERMISSION) ? authority : null;
};

type VisibilityChangeOptions = {
  actor: WorkspaceUpdateActor;
  authority: AuthorizedMemberRole;
  workspace: { leadUserId: string | null; visibility: MatterVisibility };
  body: {
    visibility?: MatterVisibility;
    confirmWidening?: true;
    leadUserId?: string | null;
  };
};

/**
 * Who sees and who leads the matter are its stewardship: only its current
 * lead (as stored before this request) or an organization owner or admin may
 * change either, so nobody can name themselves lead and then widen the
 * matter. Showing it to more people needs an explicit confirmation.
 * Narrowing to assigned_only also needs an assigned internal member; the
 * database refuses the write otherwise (`workspaces_assigned_only_steward`).
 */
const checkStewardshipChange = ({
  actor,
  authority,
  workspace,
  body,
}: VisibilityChangeOptions) => {
  const visibilityChanges =
    body.visibility !== undefined && body.visibility !== workspace.visibility;
  const leadChanges =
    body.leadUserId !== undefined && body.leadUserId !== workspace.leadUserId;
  if (!visibilityChanges && !leadChanges) {
    return null;
  }
  if (
    !hasManagementPermission(authority, UPDATE_PERMISSION) &&
    workspace.leadUserId !== actor.userId
  ) {
    return {
      ok: false as const,
      status: 403 as const,
      message:
        "Only the matter lead or an organization owner or admin can change who leads or can see this matter",
    };
  }
  if (
    body.visibility !== undefined &&
    widensMatterVisibility(workspace.visibility, body.visibility) &&
    body.confirmWidening !== true
  ) {
    return {
      ok: false as const,
      status: 409 as const,
      code: MATTER_VISIBILITY_WIDENING_UNCONFIRMED_CODE,
      message:
        "This shows the matter to people who cannot see it now. Confirm the change to apply it.",
    };
  }
  return null;
};

/** The locked matter as stored, with its effective visibility. */
const readLockedWorkspace = async (options: CurrentAuthorityOptions) => {
  const { tx, organizationId, workspaceId } = options;
  const rows = await tx
    .select({
      id: workspaces.id,
      name: workspaces.name,
      clientId: workspaces.clientId,
      reference: workspaces.reference,
      billingReference: workspaces.billingReference,
      billingNarrativeLanguage: workspaces.billingNarrativeLanguage,
      color: workspaces.color,
      documentNamingEnabled: workspaces.documentNamingEnabled,
      leadUserId: workspaces.leadUserId,
      storedVisibility: workspaces.visibility,
    })
    .from(workspaces)
    .where(
      and(
        eq(workspaces.id, workspaceId),
        eq(workspaces.organizationId, organizationId),
      ),
    );
  const row = rows.at(0);
  const authority =
    row === undefined ? null : await readCurrentUpdateAuthority(options);
  return row === undefined || authority === null
    ? null
    : {
        row,
        authority,
        workspace: {
          ...row,
          visibility: effectiveMatterVisibility({
            visibility: row.storedVisibility,
            clientId: row.clientId,
          }),
        },
      };
};

export type UpdateWorkspaceHandlerProps = {
  actor: WorkspaceUpdateActor;
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: v.InferOutput<typeof updateWorkspaceBodySchema>;
};

/** Repairs the matter's search projection after the response, off the request. */
const flushUpdatedWorkspaceSearch = (workspaceId: SafeId<"workspace">) => {
  detached(
    async () =>
      flushWorkspaceSearchRepairs([workspaceId]).catch(
        createErrorCapture(
          handlerErrorContext(
            "updateWorkspaceHandler.flushWorkspaceSearchRepairs",
          ),
        ),
      ),
    "workspaces-update.flush-workspace-search-repairs",
  );
};

type HeldClientOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  body: { clientId?: SafeId<"contact"> | undefined };
  workspace: { id: SafeId<"workspace">; clientId: SafeId<"contact"> | null };
};

/** A held matter keeps the client its evidence names. */
const heldClient = async ({
  tx,
  organizationId,
  body,
  workspace,
}: HeldClientOptions) => {
  if (body.clientId === undefined || body.clientId === workspace.clientId) {
    return null;
  }
  const hold = await requireNoHold({
    tx,
    organizationId,
    target: { type: "matter", workspaceId: workspace.id },
  });
  return hold.isErr()
    ? { ok: false as const, refusal: legalHoldRefusal(hold.error) }
    : null;
};

type AuditedWorkspace = Record<
  | "name"
  | "clientId"
  | "reference"
  | "billingNarrativeLanguage"
  | "billingReference"
  | "color"
  | "documentNamingEnabled"
  | "leadUserId",
  unknown
>;

const workspaceAuditChanges = (
  body: UpdateWorkspaceHandlerProps["body"],
  workspace: AuditedWorkspace,
) => {
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  if (body.name !== undefined && body.name !== workspace.name) {
    changes["name"] = { old: workspace.name, new: body.name };
  }
  if (body.clientId !== undefined && body.clientId !== workspace.clientId) {
    changes["clientId"] = { old: workspace.clientId, new: body.clientId };
  }
  if (body.reference !== undefined && body.reference !== workspace.reference) {
    changes["reference"] = {
      old: workspace.reference,
      new: body.reference,
    };
  }
  if (
    body.billingNarrativeLanguage !== undefined &&
    body.billingNarrativeLanguage !== workspace.billingNarrativeLanguage
  ) {
    Object.assign(changes, {
      billingNarrativeLanguage: {
        old: workspace.billingNarrativeLanguage,
        new: body.billingNarrativeLanguage,
      },
    });
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
    body.documentNamingEnabled !== undefined &&
    body.documentNamingEnabled !== workspace.documentNamingEnabled
  ) {
    changes["documentNamingEnabled"] = {
      old: workspace.documentNamingEnabled,
      new: body.documentNamingEnabled,
    };
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
  return changes;
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
    await withAggregateLock({
      aggregate: "workspace",
      id: { id: workspaceId, organizationId },
      tx,
      mode: "update",
    });
    const locked = await readLockedWorkspace({
      tx,
      organizationId,
      workspaceId,
      actor,
    });
    if (!locked) {
      return {
        ok: false as const,
        status: 404 as const,
        message: "Workspace not found",
      };
    }
    const { row, workspace, authority } = locked;

    const visibilityRefusal = checkStewardshipChange({
      actor,
      authority,
      workspace,
      body,
    });
    if (visibilityRefusal) {
      return visibilityRefusal;
    }

    const held = await heldClient({ tx, organizationId, body, workspace });
    if (held) {
      return held;
    }

    if (body.clientId !== undefined) {
      const client = await tx
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.id, body.clientId),
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

    const leadCheck = await validateLeadIsMember(
      tx,
      body.leadUserId,
      workspaceId,
    );
    if (leadCheck) {
      return leadCheck;
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

    const conditions = [eq(workspaces.id, workspaceId)];
    if (body.expectedClientId === null) {
      conditions.push(isNull(workspaces.clientId));
    } else if (body.expectedClientId !== undefined) {
      conditions.push(eq(workspaces.clientId, body.expectedClientId));
    }

    // A matter saved before visibility was stored follows its client. A
    // client change stores the visibility it has now, so attaching or
    // removing a client never changes who can see it.
    const visibility =
      body.visibility ??
      (body.clientId !== undefined && row.storedVisibility === null
        ? workspace.visibility
        : undefined);
    const updated = await tx
      .update(workspaces)
      .set({
        ...pickDefined(body, [
          "name",
          "clientId",
          "reference",
          "billingReference",
          "billingNarrativeLanguage",
          "color",
          "documentNamingEnabled",
          "leadUserId",
        ]),
        ...(visibility === undefined ? {} : { visibility }),
      })
      .where(and(...conditions))
      .returning({ id: workspaces.id });

    if (updated.length === 0) {
      return abortTransaction(
        new HandlerError({
          status: 409,
          code: API_VERSION_CONFLICT_ERROR_CODE,
          message:
            "Matter client has changed; refresh the matter before retrying",
        }),
      );
    }

    const changes = workspaceAuditChanges(body, workspace);
    const visibilityChange =
      body.visibility === undefined || body.visibility === workspace.visibility
        ? null
        : { old: workspace.visibility, new: body.visibility };
    if (visibilityChange) {
      changes["visibility"] = visibilityChange;
    }

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
      resourceId: workspaceId,
      changes,
      // Widening shows the matter's contents to people who could not see
      // them before; the marker lets the audit log filter those changes.
      ...(visibilityChange
        ? {
            metadata: {
              visibilityChange: widensMatterVisibility(
                visibilityChange.old,
                visibilityChange.new,
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
    const error = transactionAbortError(txResult.error);
    // The stewardship refusal answers MCP callers too, not only HTTP.
    const refusal = databaseConstraintRefusal(error);
    if (refusal) {
      return yield* Result.err(refusal);
    }
    if (DatabaseError.is(error) && error.code === PG_ERROR.UNIQUE_VIOLATION) {
      return yield* Result.err(
        new HandlerError({ status: 409, message: "Duplicate value" }),
      );
    }
    return yield* Result.err(error);
  }

  const failure = txResult.value;
  if (!failure.ok) {
    return yield* Result.err(
      "refusal" in failure
        ? failure.refusal
        : new HandlerError({
            status: failure.status,
            message: failure.message,
            ...(failure.status === 409 ? { code: failure.code } : {}),
          }),
    );
  }

  flushUpdatedWorkspaceSearch(workspaceId);

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
      actor: { userId: user.id, authority: memberRole },
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default updateWorkspace;
