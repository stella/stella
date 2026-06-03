import { Result } from "better-result";
import { t } from "elysia";

import {
  normalizePracticeJurisdictions,
  upsertPracticeJurisdictions,
} from "@/api/handlers/organization-settings/practice-jurisdictions";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const practiceJurisdictionSchema = t.Object({
  countryCode: t.String({
    minLength: 2,
    maxLength: 2,
    pattern: "^[A-Za-z]{2}$",
  }),
  isPrimary: t.Boolean(),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  body: t.Object({
    practiceJurisdictions: t.Array(practiceJurisdictionSchema, {
      maxItems: LIMITS.practiceJurisdictionsPerOrganization,
    }),
  }),
} satisfies HandlerConfig;

const updatePracticeJurisdictions = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const primaryCount = body.practiceJurisdictions.filter(
      (jurisdiction) => jurisdiction.isPrimary,
    ).length;

    if (primaryCount > 1) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Only one jurisdiction can be primary",
        }),
      );
    }

    const practiceJurisdictions = normalizePracticeJurisdictions(
      body.practiceJurisdictions,
    );

    yield* Result.await(
      safeDb(async (tx) => {
        await upsertPracticeJurisdictions({
          organizationId: session.activeOrganizationId,
          practiceJurisdictions,
          recordAuditEvent,
          tx,
        });
      }),
    );

    return Result.ok({ practiceJurisdictions });
  },
);

export default updatePracticeJurisdictions;
