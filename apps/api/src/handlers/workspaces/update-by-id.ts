import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { contacts, workspaces } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";
import { pickDefined } from "@/api/lib/pick-defined";
import { upsertWorkspaceSearchDocument } from "@/api/lib/search/index-global";

const config = {
  permissions: { workspace: ["update"] },
  body: t.Object({
    name: t.Optional(tDefaultVarchar),
    clientId: t.Optional(tSafeId("contact")),
    reference: t.Optional(t.String({ maxLength: 64, minLength: 1 })),
    billingReference: t.Optional(t.Nullable(t.String({ maxLength: 128 }))),
    color: t.Optional(t.Nullable(t.String({ maxLength: 32 }))),
  }),
} satisfies HandlerConfig;

const updateWorkspace = createSafeHandler(
  config,
  async function* ({ safeDb, session, workspaceId, user, request, body }) {
    const txResult = await safeDb(async (tx) => {
      const workspaceRows = await tx
        .select({
          id: workspaces.id,
          name: workspaces.name,
          clientId: workspaces.clientId,
          reference: workspaces.reference,
          billingReference: workspaces.billingReference,
          color: workspaces.color,
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

      if (body.clientId) {
        const client = await tx
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.id, body.clientId),
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

      await tx
        .update(workspaces)
        .set(
          pickDefined(body, [
            "name",
            "clientId",
            "reference",
            "billingReference",
            "color",
          ]),
        )
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

      await writeAuditLog(
        {
          ...createAuditContext({
            organizationId: session.activeOrganizationId,
            workspaceId,
            userId: user.id,
            request,
          }),
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.WORKSPACE,
          resourceId: workspaceId,
          changes,
        },
        tx,
      );

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
