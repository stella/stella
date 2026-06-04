import { Result } from "better-result";

import type { PracticeJurisdiction } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

type OrganizationSettingsRow = {
  matterNumberPadding: number;
  matterNumberPattern: string;
  practiceJurisdictions: PracticeJurisdiction[];
  promptCachingEnabled: boolean;
};

export const projectOrganizationSettingsRow = (
  row: OrganizationSettingsRow | null | undefined,
) => ({
  matterNumberPattern:
    row?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN,
  matterNumberPadding:
    row?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING,
  practiceJurisdictions: row?.practiceJurisdictions ?? [],
  promptCachingEnabled: row?.promptCachingEnabled ?? true,
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
          },
        }),
      ),
    );

    return Result.ok(projectOrganizationSettingsRow(row));
  },
);

export default readOrganizationSettings;
