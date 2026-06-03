import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import type { Transaction } from "@/api/db";
import { member } from "@/api/db/auth-schema";
import { contacts, workspaceMembers, workspaces } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { upsertWorkspaceSearchDocument } from "@/api/lib/search/index-global";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    name: t.Optional(tDefaultVarchar),
    clientId: t.Optional(tSafeId("contact")),
    reference: t.Optional(t.String({ maxLength: 64, minLength: 1 })),
    billingReference: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
    color: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
    // Pinned-first avatar on the matters list. Must be an existing
    // workspace member (validated at handler time); pass null to clear.
    leadUserId: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
    // Promotion (personal -> client) is one-way and is itself the
    // sharing event: the optional memberUserIds list is added to
    // the workspace at the same time as the client is attached.
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
  }),
} satisfies HandlerConfig;

type LeadValidationFailure = {
  ok: false;
  status: 400;
  message: "Lead must be a workspace member";
};

const validateLeadIsMember = async (
  tx: Transaction,
  leadUserId: string | null | undefined,
  workspaceId: SafeId<"workspace">,
  requestedMemberUserIds: readonly string[],
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

const updateWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, body, recordAuditEvent }) {
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
              eq(contacts.organizationId, session.activeOrganizationId),
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
              eq(member.organizationId, session.activeOrganizationId),
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

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
        resourceId: workspaceId,
        changes,
      });

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

    if (!txResult.value.ok) {
      return yield* Result.err(
        new HandlerError({
          status: txResult.value.status,
          message: txResult.value.message,
        }),
      );
    }

    upsertWorkspaceSearchDocument(workspaceId).catch(captureError);

    return Result.ok(undefined);
  },
);

export default updateWorkspace;
