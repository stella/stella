import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { organizationSettings } from "@/api/db/schema";
import { disableAndPurgeSharepointForOrg } from "@/api/handlers/sharepoint/disable-purge";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { validatePattern } from "@/api/lib/matter-reference";

const updateOrganizationSettingsBodySchema = t.Object({
  matterNumberPattern: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  matterNumberPadding: t.Optional(t.Integer({ minimum: 1, maximum: 6 })),
  promptCachingEnabled: t.Optional(t.Boolean()),
  sharepointConnectionEnabled: t.Optional(t.Boolean()),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "covered", by: "manage_organization" },
  body: updateOrganizationSettingsBodySchema,
} satisfies HandlerConfig;

export type UpdateOrganizationSettingsProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  recordAuditEvent: AuditRecorder;
  body: Static<typeof updateOrganizationSettingsBodySchema>;
};

// Shared org-settings update logic reused by the HTTP handler and the
// `manage_organization` MCP tool, so both emit the identical audit event and
// enforce the matter-pattern/padding pairing and pattern validation. Only the
// non-secret settings live here; provider-secret writes are separate,
// dashboard-only endpoints (mcp: internal).
export const updateOrganizationSettingsHandler = async function* ({
  safeDb,
  organizationId,
  recordAuditEvent,
  body,
}: UpdateOrganizationSettingsProps) {
  const matterPattern = body.matterNumberPattern;
  const matterPadding = body.matterNumberPadding;
  const wantsMatterUpdate =
    matterPattern !== undefined || matterPadding !== undefined;

  if (
    wantsMatterUpdate &&
    (matterPattern === undefined || matterPadding === undefined)
  ) {
    return Result.err(
      new HandlerError({
        status: 400,
        message:
          "matterNumberPattern and matterNumberPadding must be sent together",
      }),
    );
  }

  if (matterPattern !== undefined && matterPadding !== undefined) {
    const validation = validatePattern(matterPattern, matterPadding);

    if (Result.isError(validation)) {
      return Result.err(
        new HandlerError({ status: 400, message: validation.error.message }),
      );
    }
  }

  const wantsPromptCachingUpdate = body.promptCachingEnabled !== undefined;
  // Enabling the SharePoint connection is a plain org-scoped toggle handled
  // here; disabling it must also revoke every member's tokens, which crosses
  // the per-user RLS, so it runs through the elevated purge below instead.
  const wantsSharepointEnable = body.sharepointConnectionEnabled === true;
  const wantsSharepointDisable = body.sharepointConnectionEnabled === false;
  const wantsSafeDbWrite =
    wantsMatterUpdate || wantsPromptCachingUpdate || wantsSharepointEnable;

  if (wantsSafeDbWrite) {
    yield* Result.await(
      safeDb(async (tx) => {
        // Only touch a toggle when the body carries it; omitting it from the
        // upsert set keeps a concurrent request from being clobbered by a
        // stale read.
        const needsExisting = wantsPromptCachingUpdate || wantsSharepointEnable;
        const existing = needsExisting
          ? await tx.query.organizationSettings.findFirst({
              where: { organizationId: { eq: organizationId } },
              columns: {
                promptCachingEnabled: true,
                sharepointConnectionEnabled: true,
              },
            })
          : undefined;

        // Insert path needs schema defaults for any required column
        // the body did not carry. Matter columns are NOT NULL with
        // schema defaults — Drizzle infers them when omitted.
        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId,
            ...(wantsMatterUpdate
              ? {
                  matterNumberPattern: body.matterNumberPattern,
                  matterNumberPadding: body.matterNumberPadding,
                }
              : {}),
            ...(wantsPromptCachingUpdate
              ? { promptCachingEnabled: body.promptCachingEnabled }
              : {}),
            ...(wantsSharepointEnable
              ? { sharepointConnectionEnabled: true }
              : {}),
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              ...(wantsMatterUpdate
                ? {
                    matterNumberPattern: body.matterNumberPattern,
                    matterNumberPadding: body.matterNumberPadding,
                  }
                : {}),
              ...(wantsPromptCachingUpdate
                ? { promptCachingEnabled: body.promptCachingEnabled }
                : {}),
              ...(wantsSharepointEnable
                ? { sharepointConnectionEnabled: true }
                : {}),
              updatedAt: new Date(),
            },
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: organizationId,
          changes: {
            ...(wantsMatterUpdate
              ? {
                  matterNumberPattern: {
                    old: null,
                    new: body.matterNumberPattern,
                  },
                  matterNumberPadding: {
                    old: null,
                    new: body.matterNumberPadding,
                  },
                }
              : {}),
            ...(wantsPromptCachingUpdate &&
            body.promptCachingEnabled !==
              (existing?.promptCachingEnabled ?? true)
              ? {
                  promptCachingEnabled: {
                    old: existing?.promptCachingEnabled ?? true,
                    new: body.promptCachingEnabled,
                  },
                }
              : {}),
            ...(wantsSharepointEnable &&
            (existing?.sharepointConnectionEnabled ?? false) !== true
              ? {
                  sharepointConnectionEnabled: {
                    old: existing?.sharepointConnectionEnabled ?? false,
                    new: true,
                  },
                }
              : {}),
          },
        });
      }),
    );
  }

  // Disabling is a revocation: set the toggle false AND purge every member's
  // stored tokens in one elevated transaction. Runs after any same-request
  // matter/prompt update above; a disable request typically arrives alone.
  if (wantsSharepointDisable) {
    const purge = await Result.tryPromise({
      try: async () =>
        await disableAndPurgeSharepointForOrg({
          organizationId,
          recordAuditEvent,
        }),
      catch: (cause) =>
        new HandlerError({
          status: 500,
          message: "Failed to disable the SharePoint connection",
          cause,
        }),
    });
    if (Result.isError(purge)) {
      return Result.err(purge.error);
    }
  }

  return Result.ok({
    ...(body.matterNumberPattern !== undefined
      ? { matterNumberPattern: body.matterNumberPattern }
      : {}),
    ...(body.matterNumberPadding !== undefined
      ? { matterNumberPadding: body.matterNumberPadding }
      : {}),
    ...(body.promptCachingEnabled !== undefined
      ? { promptCachingEnabled: body.promptCachingEnabled }
      : {}),
    ...(body.sharepointConnectionEnabled !== undefined
      ? { sharepointConnectionEnabled: body.sharepointConnectionEnabled }
      : {}),
  });
};

const updateOrganizationSettings = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    return yield* updateOrganizationSettingsHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      recordAuditEvent,
      body,
    });
  },
);

export default updateOrganizationSettings;
