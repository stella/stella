import { Result } from "better-result";
import { and, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import {
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
  workspaces,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const bodySchema = t.Object({
  address: t.String({ format: "email", minLength: 3, maxLength: 320 }),
  scope: t.Union([t.Literal("organization"), t.Literal("matters")]),
  matterIds: t.Optional(
    t.Array(tSafeId("workspace"), { maxItems: 200, uniqueItems: true }),
  ),
});

const config = {
  description: "Approve a shared mailbox address for filing correspondence.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "correspondence" },
  body: bodySchema,
} satisfies HandlerConfig;

const createAllowedSender = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, user, recordAuditEvent }) {
    const address = body.address.trim().toLowerCase();
    const workspaceIds = body.matterIds ?? [];
    if (
      (body.scope === "organization" && workspaceIds.length > 0) ||
      (body.scope === "matters" && workspaceIds.length === 0)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Matter scope requires one or more matters; organization scope cannot list matters",
        }),
      );
    }

    const created = yield* Result.await(
      safeDb(async (tx) => {
        const matchingWorkspaces =
          workspaceIds.length === 0
            ? []
            : await tx
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(
                  and(
                    eq(workspaces.organizationId, session.activeOrganizationId),
                    inArray(workspaces.id, workspaceIds),
                  ),
                );
        if (matchingWorkspaces.length !== workspaceIds.length) {
          return { kind: "invalid_matters" as const };
        }

        const insertedRows = await tx
          .insert(correspondenceAllowedSenders)
          .values({
            organizationId: session.activeOrganizationId,
            address,
            kind: "shared_mailbox",
            scope: body.scope,
            approvedBy: user.id,
          })
          .onConflictDoNothing()
          .returning({ id: correspondenceAllowedSenders.id });
        const inserted = insertedRows.at(0);
        if (!inserted) {
          return { kind: "duplicate" as const };
        }

        if (matchingWorkspaces.length > 0) {
          await tx.insert(correspondenceAllowedSenderMatters).values(
            matchingWorkspaces.map(({ id }) => ({
              organizationId: session.activeOrganizationId,
              workspaceId: id,
              allowedSenderId: inserted.id,
            })),
          );
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          metadata: {
            field: "correspondenceAllowedSender",
            allowedSenderId: inserted.id,
            kind: "shared_mailbox",
            scope: body.scope,
          },
        });
        return { kind: "created" as const, id: inserted.id };
      }),
    );

    if (created.kind === "invalid_matters") {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "One or more matters do not belong to the active organization",
        }),
      );
    }
    if (created.kind === "duplicate") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This address is already approved",
        }),
      );
    }
    return Result.ok({
      id: created.id,
      address,
      kind: "shared_mailbox" as const,
      scope: body.scope,
      matterIds: workspaceIds,
    });
  },
);

export default createAllowedSender;
