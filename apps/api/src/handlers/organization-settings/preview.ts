import { Result } from "better-result";
import { status, t } from "elysia";
import type { Static } from "elysia";

import type { ScopedDb } from "@/api/db";
import type { SafeId } from "@/api/lib/branded-types";
import {
  toReference,
  toScopeKey,
  validatePattern,
} from "@/api/lib/matter-reference";

export const previewOrganizationSettingsBodySchema = t.Object({
  matterNumberPattern: t.String({ minLength: 1, maxLength: 128 }),
  matterNumberPadding: t.Integer({ minimum: 1, maximum: 6 }),
});

type PreviewOrganizationSettingsBodySchema = Static<
  typeof previewOrganizationSettingsBodySchema
>;

type PreviewOrganizationSettingsHandlerProps = {
  scopedDb: ScopedDb;
  organizationId: SafeId<"organization">;
  body: PreviewOrganizationSettingsBodySchema;
};

export const previewOrganizationSettingsHandler = async ({
  scopedDb,
  organizationId,
  body,
}: PreviewOrganizationSettingsHandlerProps) => {
  const validation = validatePattern(
    body.matterNumberPattern,
    body.matterNumberPadding,
  );

  if (Result.isError(validation)) {
    return status(400, { message: validation.error.message });
  }

  const now = new Date();
  const scopeKey = toScopeKey(body.matterNumberPattern, now);

  const counter = await scopedDb((tx) =>
    tx.query.matterCounters.findFirst({
      where: { organizationId: { eq: organizationId }, scopeKey },
      columns: { lastValue: true },
    }),
  );

  const nextValue = (counter?.lastValue ?? 0) + 1;
  const preview = toReference(
    body.matterNumberPattern,
    now,
    nextValue,
    body.matterNumberPadding,
  );

  return { preview, nextValue };
};
