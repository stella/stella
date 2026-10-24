import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import { MATTER_REFERENCE_RETIRED_CODE } from "@stll/api-contract";

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
import { narrativeLanguageSchema } from "@/api/lib/billing/narrative-language";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";
import { flushWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueWorkspaceSearchRepairs } from "@/api/lib/search/projection-repair-queue";

const updateWorkspaceBodySchema = t.Object({
  name: t.Optional(tDefaultVarchar),
  clientId: t.Optional(tSafeId("contact")),
  reference: t.Optional(t.String({ maxLength: 64, minLength: 1 })),
  billingNarrativeLanguage: t.Optional(narrativeLanguageSchema),
  billingReference: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
  color: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  // Pinned-first avatar on the matters list. Must be an existing
  // workspace member (validated at handler time); pass null to clear.
  leadUserId: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
});

const config = {
  contract: "patch",
  description:
    "Change a matter: its name, client, reference, billing reference, the " +
    "language its billing narratives are written in, colour, or lead (who " +
    "must already be a member of it). Only the fields you pass " +
    "are written. clientId attaches a client to a personal matter or replaces " +
    "the client of a client matter; members are managed separately.",
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

export type UpdateWorkspaceHandlerProps = {
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
    const workspaceRows = await tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        clientId: workspaces.clientId,
        reference: workspaces.reference,
        billingReference: workspaces.billingReference,
        billingNarrativeLanguage: workspaces.billingNarrativeLanguage,
        color: workspaces.color,
        leadUserId: workspaces.leadUserId,
      })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.organizationId, organizationId),
        ),
      );
    const workspace = workspaceRows.at(0);

    if (!workspace) {
      return {
        ok: false as const,
        status: 404 as const,
        message: "Workspace not found",
      };
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

    await tx
      .update(workspaces)
      .set({
        ...pickDefined(body, [
          "name",
          "clientId",
          "reference",
          "billingReference",
          "billingNarrativeLanguage",
          "color",
          "leadUserId",
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
      body.leadUserId !== undefined &&
      body.leadUserId !== workspace.leadUserId
    ) {
      changes["leadUserId"] = {
        old: workspace.leadUserId,
        new: body.leadUserId,
      };
    }

    await recordAuditEvent(tx, {
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
      resourceId: workspaceId,
      changes,
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
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
    return yield* updateWorkspaceHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default updateWorkspace;
