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
    description: "ISO 3166-1 alpha-2 country code",
  }),
  isPrimary: t.Boolean({
    description: "Whether this is the organization's primary jurisdiction",
  }),
});

const config = {
  description:
    "Set the practice jurisdictions for the user's stella organization. " +
    "Call this when the org's practice jurisdictions are empty (e.g., the " +
    "user signed up via an OAuth client and skipped onboarding). Pass an " +
    "array of {countryCode, isPrimary}; exactly one entry should be primary.",
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "tool", name: "set_practice_jurisdictions" },
  body: t.Object({
    practiceJurisdictions: t.Array(practiceJurisdictionSchema, {
      maxItems: LIMITS.practiceJurisdictionsPerOrganization,
      description:
        "Practice jurisdictions for this organization. countryCode is an " +
        "ISO 3166-1 alpha-2 code; exactly one entry should set isPrimary " +
        "to true.",
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
