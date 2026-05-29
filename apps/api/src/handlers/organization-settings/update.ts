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
  matterNumberPattern: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  matterNumberPadding: t.Optional(t.Integer({ minimum: 1, maximum: 6 })),
  promptCachingEnabled: t.Optional(t.Boolean()),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: updateOrganizationSettingsBodySchema,
} satisfies HandlerConfig;

const updateOrganizationSettings = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const wantsMatterUpdate =
      body.matterNumberPattern !== undefined ||
      body.matterNumberPadding !== undefined;

    if (
      wantsMatterUpdate &&
      (body.matterNumberPattern === undefined ||
        body.matterNumberPadding === undefined)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "matterNumberPattern and matterNumberPadding must be sent together",
        }),
      );
    }

    if (wantsMatterUpdate) {
      const validation = validatePattern(
        // SAFETY: branch only entered when both are defined per the guard above.
        body.matterNumberPattern as string,
        body.matterNumberPadding as number,
      );

      if (Result.isError(validation)) {
        return Result.err(
          new HandlerError({ status: 400, message: validation.error.message }),
        );
      }
    }

    yield* Result.await(
      safeDb(async (tx) => {
        // Only touch promptCachingEnabled when the body carries it;
        // omitting it from the upsert set keeps a concurrent toggle
        // request from being clobbered by a stale read.
        const wantsPromptCachingUpdate = body.promptCachingEnabled !== undefined;
        const existing = wantsPromptCachingUpdate
          ? await tx.query.organizationSettings.findFirst({
              where: { organizationId: { eq: session.activeOrganizationId } },
              columns: { promptCachingEnabled: true },
            })
          : undefined;

        // Insert path needs schema defaults for any required column
        // the body did not carry. Matter columns are NOT NULL with
        // schema defaults — Drizzle infers them when omitted.
        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId: session.activeOrganizationId,
            ...(wantsMatterUpdate
              ? {
                  matterNumberPattern: body.matterNumberPattern,
                  matterNumberPadding: body.matterNumberPadding,
                }
              : {}),
            ...(wantsPromptCachingUpdate
              ? { promptCachingEnabled: body.promptCachingEnabled }
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
              updatedAt: new Date(),
            },
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
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
          },
        });
      }),
    );

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
    });
  },
);

export default updateOrganizationSettings;
