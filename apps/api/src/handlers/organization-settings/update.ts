import { Result } from "better-result";
import { status, t } from "elysia";
import { nanoid } from "nanoid";

import { organizationSettings } from "@/api/db/schema";
import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { validatePattern } from "@/api/lib/matter-reference";

const updateOrganizationSettingsBodySchema = t.Object({
  matterNumberPattern: t.String({ minLength: 1, maxLength: 128 }),
  matterNumberPadding: t.Integer({ minimum: 1, maximum: 6 }),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: updateOrganizationSettingsBodySchema,
} satisfies HandlerConfig;

const updateOrganizationSettings = createRootHandler(
  config,
  async ({ scopedDb, session, body }) => {
    const validation = validatePattern(
      body.matterNumberPattern,
      body.matterNumberPadding,
    );

    if (Result.isError(validation)) {
      return status(400, { message: validation.error.message });
    }

    await scopedDb((tx) =>
      tx
        .insert(organizationSettings)
        .values({
          id: nanoid(),
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
    );

    return {
      matterNumberPattern: body.matterNumberPattern,
      matterNumberPadding: body.matterNumberPadding,
    };
  },
);

export default updateOrganizationSettings;
