import { Result } from "better-result";
import { eq } from "drizzle-orm";

import type { OrganizationDataBoxesResponse } from "@stll/api-contract/data-box";

import { organizationSettings } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

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
          .select({ dataBoxIds: organizationSettings.dataBoxIds })
          .from(organizationSettings)
          .where(
            eq(
              organizationSettings.organizationId,
              session.activeOrganizationId,
            ),
          )
          .limit(1);
        return settings?.dataBoxIds ?? [];
      }),
    );
    return Result.ok({ boxIds } satisfies OrganizationDataBoxesResponse);
  },
);

export default getOrganizationDataBoxes;
