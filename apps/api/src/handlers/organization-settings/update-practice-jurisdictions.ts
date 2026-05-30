import { Result } from "better-result";
import { t } from "elysia";

import { isCountryCode } from "@stll/country-codes";

import { organizationSettings } from "@/api/db/schema";
import type { PracticeJurisdiction } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
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

type RawJurisdictionInput = {
  countryCode: string;
  isPrimary: boolean;
};

// Drops entries whose countryCode is not in @stll/country-codes, deduplicates
// by canonical (uppercased) code, and ensures at most one entry is primary —
// promoting the first item if none was flagged.
const normalizePracticeJurisdictions = (
  jurisdictions: readonly RawJurisdictionInput[],
): PracticeJurisdiction[] => {
  const normalized: PracticeJurisdiction[] = [];
  const seen = new Set<string>();
  let primaryAssigned = false;

  for (const jurisdiction of jurisdictions) {
    const countryCode = jurisdiction.countryCode.toUpperCase();

    if (!isCountryCode(countryCode) || seen.has(countryCode)) {
      continue;
    }

    seen.add(countryCode);
    const isPrimary: boolean = jurisdiction.isPrimary && !primaryAssigned;
    primaryAssigned = primaryAssigned || isPrimary;
    normalized.push({ countryCode, isPrimary });
  }

  if (normalized.length === 0 || primaryAssigned) {
    return normalized;
  }

  const first = normalized.at(0);

  if (!first) {
    return normalized;
  }

  return [{ ...first, isPrimary: true }, ...normalized.slice(1)];
};

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
        const previous = await tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: { practiceJurisdictions: true },
        });

        await tx
          .insert(organizationSettings)
          .values({
            id: createSafeId<"organizationSettings">(),
            organizationId: session.activeOrganizationId,
            practiceJurisdictions,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              practiceJurisdictions,
              updatedAt: new Date(),
            },
          });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          changes: {
            practiceJurisdictions: {
              old: previous?.practiceJurisdictions ?? [],
              new: practiceJurisdictions,
            },
          },
        });
      }),
    );

    return Result.ok({ practiceJurisdictions });
  },
);

export default updatePracticeJurisdictions;
