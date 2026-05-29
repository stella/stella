import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

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

    return Result.ok({
      matterNumberPattern:
        row?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN,
      matterNumberPadding:
        row?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING,
      practiceJurisdictions: row?.practiceJurisdictions ?? [],
      promptCachingEnabled: row?.promptCachingEnabled ?? true,
    });
  },
);

export default readOrganizationSettings;
