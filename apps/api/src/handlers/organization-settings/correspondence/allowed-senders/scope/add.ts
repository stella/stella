import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  correspondenceAllowedSenderMatters,
  correspondenceAllowedSenders,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const bodySchema = t.Object({ matterId: tSafeId("workspace") });
const paramsSchema = t.Object({
  senderId: tSafeId("correspondenceAllowedSender"),
});
const MAX_MATTER_SCOPE_SIZE = 200;
const config = {
  description:
    "Allow an approved shared mailbox to file correspondence for one matter.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "correspondence" },
  params: paramsSchema,
  body: bodySchema,
} satisfies HandlerConfig;

const addAllowedSenderMatter = createSafeRootHandler(
  config,
  async function* ({ body, params, safeDb, session, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const senderRows = await tx
          .select({
            id: correspondenceAllowedSenders.id,
            scope: correspondenceAllowedSenders.scope,
            revokedAt: correspondenceAllowedSenders.revokedAt,
          })
          .from(correspondenceAllowedSenders)
          .where(
            and(
              eq(correspondenceAllowedSenders.id, params.senderId),
              eq(
                correspondenceAllowedSenders.organizationId,
                session.activeOrganizationId,
              ),
              eq(correspondenceAllowedSenders.kind, "shared_mailbox"),
            ),
          )
          .for("update");
        const sender = senderRows.at(0);
        if (!sender) {
          return { kind: "missing_sender" as const };
        }
        if (sender.revokedAt !== null) {
          return { kind: "revoked" as const };
        }
        if (sender.scope !== "matters") {
          return { kind: "organization_scope" as const };
        }

        const workspace = await tx.query.workspaces.findFirst({
          where: {
            id: { eq: body.matterId },
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: { id: true },
        });
        if (!workspace) {
          return { kind: "missing_workspace" as const };
        }

        const [existingScope] = await tx
          .select({ id: correspondenceAllowedSenderMatters.id })
          .from(correspondenceAllowedSenderMatters)
          .where(
            and(
              eq(
                correspondenceAllowedSenderMatters.organizationId,
                session.activeOrganizationId,
              ),
              eq(correspondenceAllowedSenderMatters.allowedSenderId, sender.id),
              eq(correspondenceAllowedSenderMatters.workspaceId, body.matterId),
            ),
          )
          .limit(1);
        if (existingScope) {
          return { kind: "added" as const };
        }

        const scopeRows = await tx
          .select({ id: correspondenceAllowedSenderMatters.id })
          .from(correspondenceAllowedSenderMatters)
          .where(
            and(
              eq(
                correspondenceAllowedSenderMatters.organizationId,
                session.activeOrganizationId,
              ),
              eq(correspondenceAllowedSenderMatters.allowedSenderId, sender.id),
            ),
          )
          .limit(MAX_MATTER_SCOPE_SIZE);
        if (scopeRows.length >= MAX_MATTER_SCOPE_SIZE) {
          return { kind: "scope_limit" as const };
        }

        const inserted = await tx
          .insert(correspondenceAllowedSenderMatters)
          .values({
            organizationId: session.activeOrganizationId,
            workspaceId: body.matterId,
            allowedSenderId: sender.id,
          })
          .onConflictDoNothing()
          .returning({ id: correspondenceAllowedSenderMatters.id });
        if (inserted.length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: session.activeOrganizationId,
            metadata: {
              field: "correspondenceAllowedSenderScope",
              allowedSenderId: sender.id,
              addedMatterId: body.matterId,
            },
          });
        }
        return { kind: "added" as const };
      }),
    );

    if (result.kind === "missing_sender") {
      return Result.err(
        new HandlerError({ status: 404, message: "Allowed sender not found" }),
      );
    }
    if (result.kind === "revoked") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "A revoked sender cannot gain matter access",
        }),
      );
    }
    if (result.kind === "organization_scope") {
      return Result.err(
        new HandlerError({
          status: 409,
          message:
            "Organization-scoped senders do not have matter-specific scope",
        }),
      );
    }
    if (result.kind === "missing_workspace") {
      return Result.err(
        new HandlerError({ status: 404, message: "Matter not found" }),
      );
    }
    if (result.kind === "scope_limit") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "Matter scope limit reached",
        }),
      );
    }
    return Result.ok({ added: true });
  },
);

export default addAllowedSenderMatter;
