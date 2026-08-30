import { Result } from "better-result";
import { t } from "elysia";

import {
  ANNOUNCEMENT_TITLE_MAX_LENGTH,
  NOTIFICATION_KIND,
} from "@stll/api-contract/notifications";

import { env } from "@/api/env";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  createNotifications,
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
};

export const createPublishAnnouncementEndpoint = ({
  getOperatorUserIds,
}: PublishAnnouncementDeps) =>
  createSafeRootHandler(config, async function* ({ body, session, user }) {
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
    const recipients = yield* Result.await(
      Result.tryPromise(
        async () =>
          await listAnnouncementRecipients(
            organizationId,
            LIMITS.announcementRecipientsMax + 1,
          ),
      ),
    );
    if (recipients.length > LIMITS.announcementRecipientsMax) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: `This organization has more than ${LIMITS.announcementRecipientsMax} members; announcements are not sized for it.`,
        }),
      );
    }

    const rows: NewNotification[] = recipients.map(
      ({ userId }): NewNotification => ({
        kind: NOTIFICATION_KIND.ANNOUNCEMENT,
        metadata: { title: body.title },
        entityType: null,
        entityId: null,
        organizationId,
        userId: brandPersistedUserId(userId),
        idempotencyKey: announcementIdempotencyKey({
          announcementKey: body.announcementKey,
          organizationId,
        }),
      }),
    );

    yield* Result.await(
      Result.tryPromise(
        async () => await createNotifications(rows, { kind: "systemFanOut" }),
      ),
    );

    return Result.ok({ recipientCount: rows.length });
  });

const announcementIdempotencyKey = ({
  announcementKey,
  organizationId,
}: {
  announcementKey: string;
  organizationId: SafeId<"organization">;
}): string => `announcement:${organizationId}:${announcementKey}`;

const publishAnnouncement = createPublishAnnouncementEndpoint({
  getOperatorUserIds: () => env.STELLA_ANNOUNCEMENT_OPERATOR_USER_IDS,
});

export default publishAnnouncement;
