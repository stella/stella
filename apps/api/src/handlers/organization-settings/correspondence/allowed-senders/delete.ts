import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { correspondenceAllowedSenders } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const paramsSchema = t.Object({
  senderId: tSafeId("correspondenceAllowedSender"),
});
const config = {
  description:
    "Revoke an approved shared mailbox sender while retaining its approval history.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "correspondence" },
  params: paramsSchema,
} satisfies HandlerConfig;

const revokeAllowedSender = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .update(correspondenceAllowedSenders)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(correspondenceAllowedSenders.id, params.senderId),
              eq(
                correspondenceAllowedSenders.organizationId,
                session.activeOrganizationId,
              ),
              eq(correspondenceAllowedSenders.kind, "shared_mailbox"),
              isNull(correspondenceAllowedSenders.revokedAt),
            ),
          )
          .returning({ id: correspondenceAllowedSenders.id });
        const revoked = rows.at(0);
        if (revoked) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: session.activeOrganizationId,
            metadata: {
              field: "correspondenceAllowedSender",
              allowedSenderId: revoked.id,
              change: "revoked",
            },
          });
          return { kind: "revoked" as const, id: revoked.id };
        }
        const [existing] = await tx
          .select({
            id: correspondenceAllowedSenders.id,
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
          .limit(1);
        return existing
          ? {
              kind: "existing" as const,
              id: existing.id,
              revokedAt: existing.revokedAt,
            }
          : { kind: "missing" as const };
      }),
    );

    if (result.kind === "missing") {
      return Result.err(
        new HandlerError({ status: 404, message: "Allowed sender not found" }),
      );
    }
    return Result.ok({ id: result.id, revoked: true });
  },
);

export default revokeAllowedSender;
