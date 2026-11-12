import { Result } from "better-result";

import type { DesktopRunnerApprovalMode } from "@stll/api-contract/desktop-runner";
import type { TimeZoneId } from "@stll/time";

import { ORGANIZATION_AI_INSTRUCTIONS_MAX_LENGTH } from "@/api/db/organization-settings-constants";
import type {
  DocumentProcessingMode,
  PracticeJurisdiction,
} from "@/api/db/schema";
import {
  DEFAULT_DOCUMENT_PROCESSING_MODE,
  DEFAULT_TIME_EDIT_WINDOW_DAYS,
  DEFAULT_TIME_MINIMUM_UNIT_MINUTES,
  DEFAULT_TIME_NARRATIVE_REQUIRED,
} from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import { localRunApprovalCeilingOf } from "@/api/lib/chat/local-run-approval-ceiling";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import {
  isFeatureAccessSnapshotForPrincipal,
  isFeatureEnabled,
} from "@/api/lib/feature-access/policy";
import type { FeatureAccessSnapshot } from "@/api/lib/feature-access/policy";
import { LIST_VERIFICATION_FEATURE_ID } from "@/api/lib/feature-access/registry";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";
import {
  effectiveOrganizationTimeZone,
  ORGANIZATION_TIME_ZONE_SOURCE,
} from "@/api/lib/organization-time-zone";

const config = {
  contract: "patch",
  description:
    "Read the organization's general settings: document processing mode, " +
    "matter-number pattern, padding, and whether titles show that number, practice jurisdictions, prompt " +
    "caching, organization AI instructions, memory extraction, time policy, the time zone whose calendar " +
    "decides the organization's day, and localRunMaxApprovalMode, the most a " +
    "chat turn run on a member's computer may do without asking. declaredFeatureIds identifies policies in force; " +
    "capabilities contains caller decisions; deploymentFeatures supplies deployment availability. " +
    "timeZoneSource says whether the zone was " +
    "chosen or derived from the primary practice jurisdiction (Europe/Prague " +
    "for CZ and SK, UTC otherwise). primaryJurisdictionTimeZone is the " +
    "zone the primary jurisdiction implies, regardless of an organization " +
    "override. An organization that has never saved " +
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
  documentProcessingMode: DocumentProcessingMode;
  matterNumberingEnabled: boolean;
  matterNumberPadding: number;
  matterNumberPattern: string;
  practiceJurisdictions: PracticeJurisdiction[];
  promptCachingEnabled: boolean;
  aiInstructions: string;
  managedAIResidency: ManagedAIResidency;
  memoryExtractionEnabled: boolean;
  localRunMaxApprovalMode: DesktopRunnerApprovalMode;
  timeMinimumUnitMinutes: number;
  timeEditWindowDays: number;
  timeLockedThroughMonth: string | null;
  timeNarrativeRequired: boolean;
  timeZone: TimeZoneId | null;
};

const projectFeatureAccess = (snapshot: FeatureAccessSnapshot) => {
  const visibleDecisions = Array.from(snapshot.decisions).filter(
    ([featureId]) =>
      featureId !== LIST_VERIFICATION_FEATURE_ID ||
      isFeatureEnabled(snapshot, featureId, snapshot),
  );
  return {
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
  };
};

const projectTimePolicy = (
  row: OrganizationSettingsRow | null | undefined,
) => ({
  timeMinimumUnitMinutes:
    row?.timeMinimumUnitMinutes ?? DEFAULT_TIME_MINIMUM_UNIT_MINUTES,
  timeEditWindowDays: row?.timeEditWindowDays ?? DEFAULT_TIME_EDIT_WINDOW_DAYS,
  timeLockedThroughMonth: row?.timeLockedThroughMonth ?? null,
  timeNarrativeRequired:
    row?.timeNarrativeRequired ?? DEFAULT_TIME_NARRATIVE_REQUIRED,
});

const projectTimeZone = (
  row: OrganizationSettingsRow | null | undefined,
  practiceJurisdictions: PracticeJurisdiction[],
) => ({
  timeZone: effectiveOrganizationTimeZone({
    timeZone: row?.timeZone ?? null,
    practiceJurisdictions,
  }),
  primaryJurisdictionTimeZone: effectiveOrganizationTimeZone({
    timeZone: null,
    practiceJurisdictions,
  }),
  timeZoneSource:
    (row?.timeZone ?? null) === null
      ? ORGANIZATION_TIME_ZONE_SOURCE.PRACTICE_JURISDICTION
      : ORGANIZATION_TIME_ZONE_SOURCE.ORGANIZATION,
});

export const projectOrganizationSettingsRow = (
  row: OrganizationSettingsRow | null | undefined,
  snapshot: FeatureAccessSnapshot,
) => {
  const practiceJurisdictions = arrayOrEmpty(row?.practiceJurisdictions);
  return {
    ...projectFeatureAccess(snapshot),
    documentProcessingMode:
      row?.documentProcessingMode ?? DEFAULT_DOCUMENT_PROCESSING_MODE,
    matterNumberPattern:
      row?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN,
    matterNumberPadding:
      row?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING,
    matterNumberingEnabled: row?.matterNumberingEnabled ?? false,
    practiceJurisdictions,
    promptCachingEnabled: row?.promptCachingEnabled ?? true,
    aiInstructions: row?.aiInstructions ?? "",
    aiInstructionsMaxLength: ORGANIZATION_AI_INSTRUCTIONS_MAX_LENGTH,
    managedAIResidency: row?.managedAIResidency ?? DEFAULT_MANAGED_AI_RESIDENCY,
    memoryExtractionEnabled: row?.memoryExtractionEnabled ?? false,
    localRunMaxApprovalMode: localRunApprovalCeilingOf(row),
    ...projectTimePolicy(row),
    ...projectTimeZone(row, practiceJurisdictions),
  };
};

const readOrganizationSettings = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, featureAccessSnapshot }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            documentProcessingMode: true,
            matterNumberPattern: true,
            matterNumberPadding: true,
            matterNumberingEnabled: true,
            practiceJurisdictions: true,
            promptCachingEnabled: true,
            aiInstructions: true,
            managedAIResidency: true,
            memoryExtractionEnabled: true,
            localRunMaxApprovalMode: true,
            timeMinimumUnitMinutes: true,
            timeEditWindowDays: true,
            timeLockedThroughMonth: true,
            timeNarrativeRequired: true,
            timeZone: true,
          },
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
