import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import {
  FLOW_TASK_FEATURE_ACCESS,
  readEntityTransferEligibility,
} from "@/api/lib/flows/review-gate-task";
import { LIMITS } from "@/api/lib/limits";

const config = {
  contract: "patch",
  description:
    "Read copy and move eligibility for entity subtrees in this matter. Transfers revalidate admission when submitted.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: FLOW_TASK_FEATURE_ACCESS,
  mcp: { type: "covered", by: "list_documents" },
  access: "read",
  body: t.Object({
    entityIds: t.Array(tSafeId("entity"), {
      maxItems: LIMITS.entitiesPageSizeMax,
    }),
  }),
} satisfies WorkspaceHandlerConfig;

const readTransferEligibility = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body: { entityIds } }) {
    const rows = yield* Result.await(
      safeDb(
        async (tx) =>
          await readEntityTransferEligibility(tx, {
            workspaceId,
            entityIds,
            userId: user.id,
          }),
      ),
    );
    const eligibility = new Map(
      rows.map(({ entityId, eligible }) => [entityId, eligible]),
    );
    return Result.ok({
      transfers: entityIds.map((entityId) => ({
        entityId,
        access:
          eligibility.get(entityId) === true
            ? ("available" as const)
            : ("unavailable" as const),
      })),
    });
  },
);

declareAggregateMutation(readTransferEligibility.handler, {
  type: "independent",
  reason:
    "Reads entity transfer eligibility without changing entity, flow, or admission rows; submitted transfers revalidate current admission.",
});

export default readTransferEligibility;
