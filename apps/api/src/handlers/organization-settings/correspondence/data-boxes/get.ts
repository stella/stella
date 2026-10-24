import { Result } from "better-result";
import { eq } from "drizzle-orm";

import type { OrganizationDataBoxesResponse } from "@stll/api-contract/data-box";

import { organizationSettings } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type OrganizationSettingsRow = typeof organizationSettings.$inferSelect;

const DATA_BOX_SETTINGS_COLUMNS = {
  dataBoxIds: organizationSettings.dataBoxIds,
};

const UNPROJECTED_DATA_BOX_SETTINGS_COLUMNS = [
  "id", // The settings row identity is not part of the data-box inventory.
  "organizationId", // The active organization scopes this read.
  "personalApiKeyPolicy", // API-key policy belongs to general settings.
  "invoiceLanguage", // Invoice language belongs to invoicing settings.
  "sanctionsMonitoringMode", // Sanctions policy belongs to general settings.
  "matterNumberingEnabled", // Matter numbering belongs to general settings.
  "matterNumberPattern", // Matter numbering belongs to general settings.
  "matterNumberPadding", // Matter numbering belongs to general settings.
  "timeMinimumUnitMinutes", // Timekeeping belongs to general settings.
  "timeEditWindowDays", // Timekeeping belongs to general settings.
  "timeLockedThroughMonth", // Timekeeping belongs to general settings.
  "timeNarrativeRequired", // Timekeeping belongs to general settings.
  "timeZone", // Timekeeping belongs to general settings.
  "documentStampEnabled", // Document processing belongs to general settings.
  "documentProcessingMode", // Document processing belongs to general settings.
  "practiceJurisdictions", // Jurisdiction preferences belong to general settings.
  "nativeToolOverrides", // Tool policy belongs to general settings.
  "disabledNativeTools", // Tool policy belongs to general settings.
  "aiConfigEncrypted", // Provider credentials must not be projected.
  "aiConfigIv", // Provider encryption metadata must not be projected.
  "deeplApiKeyEncrypted", // Provider credentials must not be projected.
  "deeplApiKeyIv", // Provider encryption metadata must not be projected.
  "webSearchApiKeyEncrypted", // Provider credentials must not be projected.
  "webSearchApiKeyIv", // Provider encryption metadata must not be projected.
  "urlFetchApiKeyEncrypted", // Provider credentials must not be projected.
  "urlFetchApiKeyIv", // Provider encryption metadata must not be projected.
  "managedAIResidency", // AI policy belongs to general settings.
  "promptCachingEnabled", // AI policy belongs to general settings.
  "sharepointConnectionEnabled", // Connection policy belongs to general settings.
  "memoryExtractionEnabled", // Memory policy belongs to general settings.
  "templatePacksHidden", // Template preferences belong to general settings.
  "memoryExtractionEnabledAt", // Extraction scheduling is internal state.
  "memoryExtractionScheduledAt", // Extraction scheduling is internal state.
  "updatedAt", // Settings bookkeeping is not part of the data-box inventory.
] as const satisfies readonly (keyof OrganizationSettingsRow)[];

type MissingDataBoxSettingsColumn = UnprojectedColumns<
  OrganizationSettingsRow,
  typeof DATA_BOX_SETTINGS_COLUMNS,
  (typeof UNPROJECTED_DATA_BOX_SETTINGS_COLUMNS)[number]
>;
type UnexpectedDataBoxSettingsColumn = UnbackedProjectionKeys<
  OrganizationSettingsRow,
  typeof DATA_BOX_SETTINGS_COLUMNS,
  (typeof UNPROJECTED_DATA_BOX_SETTINGS_COLUMNS)[number]
>;
true satisfies MissingDataBoxSettingsColumn extends never ? true : never;
true satisfies UnexpectedDataBoxSettingsColumn extends never ? true : never;

const EMPTY_DATA_BOX_IDS: string[] = [];

const config = {
  contract: "patch",
  description:
    "Read the organization's own data-box IDs (seven lowercase letters or digits). A filed data-box message sent from one of them is outgoing, one sent to them incoming; any other is incoming with directionBasis unknown.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "correspondence",
    consumesServices: false,
  },
  access: "read",
} satisfies HandlerConfig;

const getOrganizationDataBoxes = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const boxIds = yield* Result.await(
      safeDb(async (tx) => {
        const [settings] = await tx
          .select(DATA_BOX_SETTINGS_COLUMNS)
          .from(organizationSettings)
          .where(
            eq(
              organizationSettings.organizationId,
              session.activeOrganizationId,
            ),
          )
          .limit(1);
        return settings?.dataBoxIds ?? EMPTY_DATA_BOX_IDS;
      }),
    );
    return Result.ok({ boxIds } satisfies OrganizationDataBoxesResponse);
  },
);

export default getOrganizationDataBoxes;
