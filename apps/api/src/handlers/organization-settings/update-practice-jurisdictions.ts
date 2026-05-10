import { Result } from "better-result";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import type { PracticeJurisdiction } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
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

const normalizePracticeJurisdictions = (
  jurisdictions: PracticeJurisdiction[],
): PracticeJurisdiction[] => {
  const normalized: PracticeJurisdiction[] = [];
  const seen = new Set<string>();
  let primaryAssigned = false;

  for (const jurisdiction of jurisdictions) {
    const countryCode = jurisdiction.countryCode.toUpperCase();

    if (seen.has(countryCode)) {
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
  async function* ({ safeDb, session, user, request, server, body }) {
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

        await writeAuditLog(
          {
            ...createAuditContext({
              organizationId: session.activeOrganizationId,
              userId: user.id,
              request,
              server,
            }),
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
            resourceId: session.activeOrganizationId,
            changes: {
              practiceJurisdictions: {
                old: previous?.practiceJurisdictions ?? [],
                new: practiceJurisdictions,
              },
            },
          },
          tx,
        );
      }),
    );

    return Result.ok({ practiceJurisdictions });
  },
);

export default updatePracticeJurisdictions;
