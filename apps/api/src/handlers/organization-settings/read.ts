import { createRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  DEFAULT_MATTER_NUMBER_PADDING,
  DEFAULT_MATTER_NUMBER_PATTERN,
} from "@/api/lib/matter-reference";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const readOrganizationSettings = createRootHandler(
  config,
  async ({ scopedDb, session }) => {
    const row = await scopedDb((tx) =>
      tx.query.organizationSettings.findFirst({
        where: { organizationId: { eq: session.activeOrganizationId } },
        columns: {
          matterNumberPattern: true,
          matterNumberPadding: true,
        },
      }),
    );

    return {
      matterNumberPattern:
        row?.matterNumberPattern ?? DEFAULT_MATTER_NUMBER_PATTERN,
      matterNumberPadding:
        row?.matterNumberPadding ?? DEFAULT_MATTER_NUMBER_PADDING,
    };
  },
);

export default readOrganizationSettings;
