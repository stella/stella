import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import {
  dataBoxIdSchema,
  organizationDataBoxesChangeResult,
  saveOrganizationDataBoxes,
} from "@/api/lib/email/correspondence/data-box/organization-boxes";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  realtime: organizationResourceSetUpdates(RESOURCE_TYPE.ORGANIZATION),
  description:
    "Remove one of the organization's own data-box IDs. Filed data-box messages derive their direction from the current inventory on every read. Removing an ID not listed leaves the inventory unchanged.",
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: {
    type: "capability",
    reason: "correspondence",
    consumesServices: false,
  },
  params: v.object({ boxId: dataBoxIdSchema }),
} satisfies HandlerConfig;

const removeOrganizationDataBox = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, recordAuditEvent }) {
    const boxId = params.boxId.toLowerCase();
    const saved = yield* Result.await(
      safeDb(
        async (tx) =>
          await saveOrganizationDataBoxes({
            tx,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            change: (current) => current.filter((id) => id !== boxId),
          }),
      ),
    );
    return organizationDataBoxesChangeResult(saved);
  },
);

declareAggregateMutation(removeOrganizationDataBox, {
  type: "aggregate",
  aggregates: ["organizationDataBoxes"],
});

export default removeOrganizationDataBox;
