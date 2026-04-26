import { Result } from "better-result";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { validatePattern } from "@/api/lib/matter-reference";

const updateOrganizationSettingsBodySchema = t.Object({
  matterNumberPattern: t.String({ minLength: 1, maxLength: 128 }),
  matterNumberPadding: t.Integer({ minimum: 1, maximum: 6 }),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: updateOrganizationSettingsBodySchema,
} satisfies HandlerConfig;

const updateOrganizationSettings = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body }) {
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
      safeDb((tx) =>
        tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId: session.activeOrganizationId,
            matterNumberPattern: body.matterNumberPattern,
            matterNumberPadding: body.matterNumberPadding,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              matterNumberPattern: body.matterNumberPattern,
              matterNumberPadding: body.matterNumberPadding,
              updatedAt: new Date(),
            },
          }),
      ),
    );

    return Result.ok({
      matterNumberPattern: body.matterNumberPattern,
      matterNumberPadding: body.matterNumberPadding,
    });
  },
);

export default updateOrganizationSettings;
