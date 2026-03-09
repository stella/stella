import { Result } from "better-result";
import { status, t, type Static } from "elysia";
import { nanoid } from "nanoid";

import type { ScopedDb } from "@/api/db";
import { organizationSettings } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { validatePattern } from "@/api/lib/matter-reference";

export const updateOrganizationSettingsBodySchema = t.Object({
  matterNumberPattern: t.String({ minLength: 1, maxLength: 128 }),
  matterNumberPadding: t.Integer({ minimum: 1, maximum: 6 }),
});

type UpdateOrganizationSettingsBodySchema = Static<
  typeof updateOrganizationSettingsBodySchema
>;

type UpdateOrganizationSettingsHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  body: UpdateOrganizationSettingsBodySchema;
};

export const updateOrganizationSettingsHandler = async ({
  scopedDb,
  organizationId,
  body,
}: UpdateOrganizationSettingsHandlerProps) => {
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
        organizationId,
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
};
