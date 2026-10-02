import { Result } from "better-result";

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
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import {
  isFeatureAccessSnapshotForPrincipal,
  isFeatureEnabled,
} from "@/api/lib/auth/feature-access/policy";
import type { FeatureAccessSnapshot } from "@/api/lib/auth/feature-access/policy";
import { DEFAULT_MANAGED_AI_RESIDENCY } from "@/api/lib/chat/ai-data-policy";
import type { ManagedAIResidency } from "@/api/lib/chat/ai-data-policy";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";

const config = {
  description:
    "Read the organization's general settings: document processing mode, " +
    "matter-number pattern and padding, practice jurisdictions, prompt " +
    "caching, memory extraction, and time policy. An organization that has never saved " +
    "settings gets the defaults rather than an error.",
  permissions: { workspace: ["read"] },
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
};

export const projectOrganizationSettingsRow = (
  row: OrganizationSettingsRow | null | undefined,
  snapshot: FeatureAccessSnapshot,
) => ({
  capabilities: Object.fromEntries(
    Array.from(
      snapshot.decisions,
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
  documentProcessingMode:
    row?.documentProcessingMode ?? DEFAULT_DOCUMENT_PROCESSING_MODE,
  matterNumberPattern:
    row?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN,
  matterNumberPadding:
    row?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING,
  practiceJurisdictions: arrayOrEmpty(row?.practiceJurisdictions),
  promptCachingEnabled: row?.promptCachingEnabled ?? true,
  managedAIResidency: row?.managedAIResidency ?? DEFAULT_MANAGED_AI_RESIDENCY,
  memoryExtractionEnabled: row?.memoryExtractionEnabled ?? false,
  timeMinimumUnitMinutes:
    row?.timeMinimumUnitMinutes ?? DEFAULT_TIME_MINIMUM_UNIT_MINUTES,
  timeEditWindowDays: row?.timeEditWindowDays ?? DEFAULT_TIME_EDIT_WINDOW_DAYS,
  timeLockedThroughMonth: row?.timeLockedThroughMonth ?? null,
  timeNarrativeRequired:
    row?.timeNarrativeRequired ?? DEFAULT_TIME_NARRATIVE_REQUIRED,
});

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
            practiceJurisdictions: true,
            promptCachingEnabled: true,
            managedAIResidency: true,
            memoryExtractionEnabled: true,
            timeMinimumUnitMinutes: true,
            timeEditWindowDays: true,
            timeLockedThroughMonth: true,
            timeNarrativeRequired: true,
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
