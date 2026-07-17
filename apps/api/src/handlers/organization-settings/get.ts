import { Result } from "better-result";

import type { PracticeJurisdiction } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { arrayOrEmpty } from "@/api/lib/array";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "anonymization_admin" },
  access: "read",
} satisfies HandlerConfig;

type OrganizationSettingsRow = {
  matterNumberPadding: number;
  matterNumberPattern: string;
  practiceJurisdictions: PracticeJurisdiction[];
  promptCachingEnabled: boolean;
  memoryExtractionEnabled: boolean;
};

export const projectOrganizationSettingsRow = (
  row: OrganizationSettingsRow | null | undefined,
) => ({
  matterNumberPattern:
    row?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN,
  matterNumberPadding:
    row?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING,
  practiceJurisdictions: arrayOrEmpty(row?.practiceJurisdictions),
  promptCachingEnabled: row?.promptCachingEnabled ?? true,
  memoryExtractionEnabled: row?.memoryExtractionEnabled ?? false,
});

const readOrganizationSettings = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const row = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: { organizationId: { eq: session.activeOrganizationId } },
          columns: {
            matterNumberPattern: true,
            matterNumberPadding: true,
            practiceJurisdictions: true,
            promptCachingEnabled: true,
            memoryExtractionEnabled: true,
          },
        }),
      ),
    );

    return Result.ok(projectOrganizationSettingsRow(row));
  },
);

export default readOrganizationSettings;
