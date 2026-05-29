import { Result } from "better-result";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { validatePattern } from "@/api/lib/matter-reference";

const updateOrganizationSettingsBodySchema = t.Object({
  matterNumberPattern: t.String({ minLength: 1, maxLength: 128 }),
  matterNumberPadding: t.Integer({ minimum: 1, maximum: 6 }),
  promptCachingEnabled: t.Optional(t.Boolean()),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: updateOrganizationSettingsBodySchema,
} satisfies HandlerConfig;

const updateOrganizationSettings = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const validation = validatePattern(
      body.matterNumberPattern,
      body.matterNumberPadding,
    );

    if (Result.isError(validation)) {
      return Result.err(
        new HandlerError({ status: 400, message: validation.error.message }),
      );
    }

    yield* Result.await(
      safeDb(async (tx) => {
        const existing = await tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: { promptCachingEnabled: true },
        });
        const promptCachingEnabled =
          body.promptCachingEnabled ?? existing?.promptCachingEnabled ?? true;

        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId: session.activeOrganizationId,
            matterNumberPattern: body.matterNumberPattern,
            matterNumberPadding: body.matterNumberPadding,
            promptCachingEnabled,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              matterNumberPattern: body.matterNumberPattern,
              matterNumberPadding: body.matterNumberPadding,
              promptCachingEnabled,
              updatedAt: new Date(),
            },
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          changes: {
            matterNumberPattern: {
              old: null,
              new: body.matterNumberPattern,
            },
            matterNumberPadding: {
              old: null,
              new: body.matterNumberPadding,
            },
            ...(body.promptCachingEnabled !== undefined &&
            body.promptCachingEnabled !==
              (existing?.promptCachingEnabled ?? true)
              ? {
                  promptCachingEnabled: {
                    old: existing?.promptCachingEnabled ?? true,
                    new: body.promptCachingEnabled,
                  },
                }
              : {}),
          },
        });
      }),
    );

    return Result.ok({
      matterNumberPattern: body.matterNumberPattern,
      matterNumberPadding: body.matterNumberPadding,
      promptCachingEnabled: body.promptCachingEnabled,
    });
  },
);

export default updateOrganizationSettings;
