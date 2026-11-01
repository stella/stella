import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { ORGANIZATION_DATA_BOX_LIMIT } from "@stll/api-contract/data-box";

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
  description: `Add one of the organization's own data-box IDs (at most ${ORGANIZATION_DATA_BOX_LIMIT}; stored lowercase). Filed data-box messages derive their direction from this inventory on every read: organization sender is outgoing, organization recipient incoming, otherwise incoming with directionBasis unknown. Adding an existing ID leaves the inventory unchanged.`,
  permissions: { organizationSettings: ["update"] },
  accountAccess: ACCOUNT_ACCESS.standard,
  mcp: {
    type: "capability",
    reason: "correspondence",
    consumesServices: false,
  },
  body: v.object({ boxId: dataBoxIdSchema }),
} satisfies HandlerConfig;

const addOrganizationDataBox = createSafeRootHandler(
  config,
  async function* ({ body, safeDb, session, recordAuditEvent }) {
    const boxId = body.boxId.toLowerCase();
    const saved = yield* Result.await(
      safeDb(
        async (tx) =>
          await saveOrganizationDataBoxes({
            tx,
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
            change: (current) =>
              current.includes(boxId) ? [...current] : [...current, boxId],
          }),
      ),
    );
    return organizationDataBoxesChangeResult(saved);
  },
);

declareAggregateMutation(addOrganizationDataBox, {
  type: "aggregate",
  aggregates: ["organizationDataBoxes"],
});

export default addOrganizationDataBox;
