import { isCountryCode } from "@stll/country-codes";

import type { Transaction } from "@/api/db";
import { organizationSettings } from "@/api/db/schema";
import type { PracticeJurisdiction } from "@/api/db/schema";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

type RawJurisdictionInput = {
  countryCode: string;
  isPrimary: boolean;
};

// Drops entries whose countryCode is not in @stll/country-codes, deduplicates
// by canonical (uppercased) code, and ensures at most one entry is primary.
// If none was flagged, promote the first normalized item.
export const normalizePracticeJurisdictions = (
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

type UpsertPracticeJurisdictionsOptions = {
  organizationId: SafeId<"organization">;
  practiceJurisdictions: PracticeJurisdiction[];
  recordAuditEvent: AuditRecorder;
  tx: Transaction;
};

export const upsertPracticeJurisdictions = async ({
  organizationId,
  practiceJurisdictions,
  recordAuditEvent,
  tx,
}: UpsertPracticeJurisdictionsOptions) => {
  const previous = await tx.query.organizationSettings.findFirst({
    where: { organizationId: { eq: organizationId } },
    columns: { practiceJurisdictions: true },
  });

  await tx
    .insert(organizationSettings)
    .values({
      id: createSafeId<"organizationSettings">(),
      organizationId,
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
    resourceId: organizationId,
    changes: {
      practiceJurisdictions: {
        old: previous?.practiceJurisdictions ?? [],
        new: practiceJurisdictions,
      },
    },
  });
};
