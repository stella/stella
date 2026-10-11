import { Result } from "better-result";

import type { TimeZoneId } from "@stll/time";

import type {
  DocumentProcessingMode,
  PracticeJurisdiction,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  isFeatureAccessSnapshotForPrincipal,
  isFeatureEnabled,
} from "@/api/lib/feature-access/policy";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  effectiveOrganizationTimeZone,
  ORGANIZATION_TIME_ZONE_SOURCE,
} from "@/api/lib/organization-time-zone";

import { readOrCreateOrganizationSettings } from "./read-or-create";

const config = {
  contract: "patch",
  description:
    "Read the organization's general settings: document processing mode, " +
    "matter-number pattern and padding, practice jurisdictions, prompt " +
    "caching, memory extraction, time policy, and the time zone whose calendar " +
    "decides the organization's day. declaredFeatureIds identifies policies in force; " +
    "capabilities contains caller decisions; deploymentFeatures supplies deployment availability. " +
    "timeZoneSource says whether the zone was " +
    "chosen or derived from the primary practice jurisdiction (Europe/Prague " +
    "for CZ and SK, UTC otherwise). An organization that has never saved " +
    "settings gets the defaults rather than an error.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "anonymization_admin",
    consumesServices: false,
  },
  access: "read",
} satisfies HandlerConfig;

type OrganizationSettingsRow = {
  updatedAt: Date;
  documentProcessingMode: DocumentProcessingMode;
  matterNumberPadding: number;
  matterNumberPattern: string;
  practiceJurisdictions: PracticeJurisdiction[];
  promptCachingEnabled: boolean;
  managedAIResidency: ManagedAIResidency;
  memoryExtractionEnabled: boolean;
  timeMinimumUnitMinutes: number;
  timeEditWindowDays: number;
  timeLockedThroughMonth: string | null;
  timeNarrativeRequired: boolean;
  timeZone: TimeZoneId | null;
};

export const projectOrganizationSettingsRow = (
  row: OrganizationSettingsRow,
  snapshot: FeatureAccessSnapshot,
) => {
  const visibleDecisions = Array.from(snapshot.decisions).filter(
    ([featureId]) =>
      featureId !== LIST_VERIFICATION_FEATURE_ID ||
      isFeatureEnabled(snapshot, featureId, snapshot),
  );
  return {
    updatedAt: row.updatedAt.toISOString(),
    declaredFeatureIds: visibleDecisions.map(([featureId]) => featureId),
    deploymentFeatures: {
      legalLists: isDeploymentFeatureEnabled("FEATURE_LEGAL_LISTS"),
    },
    capabilities: Object.fromEntries(
      visibleDecisions.map(
        ([featureId]) =>
          [
            featureId,
            {
              status: isFeatureEnabled(snapshot, featureId, snapshot)
                ? ("enabled" as const)
                : ("hidden" as const),
            },
          ] as const,
      ),
    ),
    documentProcessingMode: row.documentProcessingMode,
    matterNumberPattern: row.matterNumberPattern,
    matterNumberPadding: row.matterNumberPadding,
    practiceJurisdictions: row.practiceJurisdictions,
    promptCachingEnabled: row.promptCachingEnabled,
    managedAIResidency: row.managedAIResidency,
    memoryExtractionEnabled: row.memoryExtractionEnabled,
    timeMinimumUnitMinutes: row.timeMinimumUnitMinutes,
    timeEditWindowDays: row.timeEditWindowDays,
    timeLockedThroughMonth: row.timeLockedThroughMonth,
    timeNarrativeRequired: row.timeNarrativeRequired,
    timeZone: effectiveOrganizationTimeZone({
      timeZone: row.timeZone,
      practiceJurisdictions: row.practiceJurisdictions,
    }),
    timeZoneSource:
      row.timeZone === null
        ? ORGANIZATION_TIME_ZONE_SOURCE.PRACTICE_JURISDICTION
        : ORGANIZATION_TIME_ZONE_SOURCE.ORGANIZATION,
  };
};

const readOrganizationSettings = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    featureAccessSnapshot,
    recordAuditEvent,
  }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        readOrCreateOrganizationSettings({
          tx,
          organizationId: session.activeOrganizationId,
          recordAuditEvent,
        }),
      ),
    );

    const principal = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    const snapshot =
      featureAccessSnapshot !== undefined &&
      isFeatureAccessSnapshotForPrincipal(featureAccessSnapshot, principal)
        ? featureAccessSnapshot
        : yield* Result.await(
            loadFeatureAccessSnapshot({ safeDb, ...principal }),
          );

    return Result.ok(projectOrganizationSettingsRow(row, snapshot));
  },
);

export default readOrganizationSettings;
