import { Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  toReference,
  toScopeKey,
  validatePattern,
} from "@/api/lib/matter-reference";

const previewOrganizationSettingsBodySchema = t.Object({
  matterNumberPattern: t.String({ minLength: 1, maxLength: 128 }),
  matterNumberPadding: t.Integer({ minimum: 1, maximum: 6 }),
});

type PreviewOrganizationSettingsBodySchema = Static<
  typeof previewOrganizationSettingsBodySchema
>;

type PreviewOrganizationSettingsHandlerProps = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  body: PreviewOrganizationSettingsBodySchema;
};

const previewOrganizationSettingsHandler = async function* ({
  safeDb,
  organizationId,
  body,
}: PreviewOrganizationSettingsHandlerProps) {
  const validation = validatePattern(
    body.matterNumberPattern,
    body.matterNumberPadding,
  );

  if (Result.isError(validation)) {
    return Result.err(
      new HandlerError({ status: 400, message: validation.error.message }),
    );
  }

  const now = new Date();
  const scopeKey = toScopeKey(body.matterNumberPattern, now);

  const counter = yield* Result.await(
    safeDb((tx) =>
      tx.query.matterCounters.findFirst({
        where: { organizationId: { eq: organizationId }, scopeKey },
        columns: { lastValue: true },
      }),
    ),
  );

  const nextValue = (counter?.lastValue ?? 0) + 1;
  const preview = toReference({
    pattern: body.matterNumberPattern,
    now,
    seq: nextValue,
    padding: body.matterNumberPadding,
  });

  return Result.ok({ preview, nextValue });
};

const config = {
  permissions: { organizationSettings: ["update"] },
  body: previewOrganizationSettingsBodySchema,
} satisfies HandlerConfig;

const previewOrganizationSettings = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body }) {
    return yield* previewOrganizationSettingsHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      body,
    });
  },
);

export default previewOrganizationSettings;
