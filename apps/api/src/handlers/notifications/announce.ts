import { Result } from "better-result";
import { t } from "elysia";

import {
  ANNOUNCEMENT_TITLE_MAX_LENGTH,
  NOTIFICATION_KIND,
} from "@stll/api-contract/notifications";

import { env } from "@/api/env";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  fanOutCrossUserNotifications,
  listAnnouncementRecipients,
} from "@/api/lib/notifications";
import type { NewNotification } from "@/api/lib/notifications";
import { logger } from "@/api/lib/observability/logger";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

const config = {
  description:
    "Publish one announcement to every member of the caller's active " +
    "organization as an unread notification. Requires operator " +
    "configuration: only user IDs listed in " +
    "STELLA_ANNOUNCEMENT_OPERATOR_USER_IDS may call it, and the endpoint " +
    "reports a configuration error when that list is unset. The announcement " +
    "is an awareness pointer with a title only; it carries no work state and " +
    "cannot be recalled once filed.",
  // permissions-exempt: the real gate is the deployment operator allowlist
  // enforced inside the handler; organization-role grants cannot model it.
  permissions: { workspace: ["read"] },
  // Internal on purpose: the gate here is deployment configuration, not an
  // organization role, so no agent consent scope can express who may call it.
  // Promoting it to a catalog capability would need a reviewed
  // `McpCapabilityReason` for operator broadcasts, which does not exist yet.
  mcp: { type: "internal", reason: "native_tool_ui" },
  access: "write",
  body: t.Object({
    title: t.String({ minLength: 1, maxLength: ANNOUNCEMENT_TITLE_MAX_LENGTH }),
    /**
     * Distinguishes two announcements with the same title, and makes a retry
     * of the same announcement a no-op instead of a second badge for everyone.
     */
    announcementKey: t.String({ minLength: 1, maxLength: 128 }),
  }),
} satisfies HandlerConfig;

/**
 * Parse the operator allowlist. Returns `null` when the deployment configured
 * none — distinct from "configured, and the caller is not on it", so the
 * endpoint can answer "misconfigured" rather than "forbidden" and never be
 * silently dead.
 */
const operatorUserIds = (raw: string | undefined): Set<string> | null => {
  if (raw === undefined) {
    return null;
  }
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  return ids.length === 0 ? null : new Set(ids);
};

export type PublishAnnouncementDeps = {
  /**
   * Reads the configured allowlist at call time. A seam, not indirection: the
   * env is parsed once at import, so without it neither the unconfigured nor
   * the not-an-operator branch could be exercised without mutating process
   * state that the parsed env no longer reads.
   */
  getOperatorUserIds: () => string | undefined;
  /** Largest audience an announcement may reach; a larger firm is refused. */
  maxRecipients: number;
  /**
   * Files the recipient rows. They are addressed to other people, which no
   * caller's scope admits, so production passes
   * {@link fanOutCrossUserNotifications}; tests pass the embedded database.
   */
  fanOut: (rows: readonly NewNotification[]) => Promise<void>;
};

export const createPublishAnnouncementEndpoint = ({
  getOperatorUserIds,
  maxRecipients,
  fanOut,
}: PublishAnnouncementDeps) =>
  createSafeRootHandler(
    config,
    async function* ({ body, recordAuditEvent, safeDb, session, user }) {
      const allowlist = operatorUserIds(getOperatorUserIds());
      if (allowlist === null) {
        logger.error("notifications.announce_unconfigured");
        return Result.err(
          new HandlerError({
            status: 500,
            message:
              "Announcements are not configured on this deployment. Set STELLA_ANNOUNCEMENT_OPERATOR_USER_IDS.",
          }),
        );
      }
      if (!allowlist.has(user.id)) {
        return Result.err(
          new HandlerError({
            status: 403,
            message: "Announcements require operator authorization",
          }),
        );
      }

      const organizationId = session.activeOrganizationId;
      const idempotencyKey = announcementIdempotencyKey({
        announcementKey: body.announcementKey,
        organizationId,
      });

      // The audience read and the audit event share the caller's scoped
      // transaction. The audit event commits before the fan-out, not after:
      // the recipient rows record only who received what, so a broadcast that
      // reached a whole firm without a durable actor trail would be exactly
      // the state this event exists to prevent. The recorder binds the
      // operator from the request, so the row names the caller the allowlist
      // admitted above. Root-scoped handler, so the workspace is explicitly
      // none.
      const audience = yield* Result.await(
        safeDb(async (tx) => {
          const recipients = await listAnnouncementRecipients(
            tx,
            organizationId,
            maxRecipients + 1,
          );
          if (recipients.length > maxRecipients) {
            return { oversized: true as const };
          }

          const rows = recipients.map((recipient): NewNotification => ({
            kind: NOTIFICATION_KIND.ANNOUNCEMENT,
            metadata: { title: body.title },
            entityType: null,
            entityId: null,
            workspaceId: null,
            organizationId,
            userId: brandPersistedUserId(recipient.userId),
            idempotencyKey,
          }));
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.CREATE,
            resourceType: AUDIT_RESOURCE_TYPE.ANNOUNCEMENT,
            resourceId: idempotencyKey,
            workspaceId: null,
            metadata: {
              title: body.title,
              recipientCount: rows.length,
            },
          });
          return { oversized: false as const, rows };
        }),
      );
      if (audience.oversized) {
        return Result.err(
          new HandlerError({
            status: 422,
            message: `This organization has more than ${maxRecipients} members; announcements are not sized for it.`,
          }),
        );
      }

      yield* Result.await(
        Result.tryPromise(async () => await fanOut(audience.rows)),
      );

      return Result.ok({ recipientCount: audience.rows.length });
    },
  );

const announcementIdempotencyKey = ({
  announcementKey,
  organizationId,
}: {
  announcementKey: string;
  organizationId: SafeId<"organization">;
}): string => `announcement:${organizationId}:${announcementKey}`;

const publishAnnouncement = createPublishAnnouncementEndpoint({
  getOperatorUserIds: () => env.STELLA_ANNOUNCEMENT_OPERATOR_USER_IDS,
  maxRecipients: LIMITS.announcementRecipientsMax,
  fanOut: fanOutCrossUserNotifications,
});

export default publishAnnouncement;
