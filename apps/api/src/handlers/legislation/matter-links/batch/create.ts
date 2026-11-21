import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { legislationMatterLinkItemSchema } from "@/api/handlers/legislation/matter-links/create";
import { linkProvisionsToMatter } from "@/api/handlers/legislation/matter-links/link-writes";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { resolveMatterLinkProvisions } from "@/api/lib/legal-search/legislation-matter-link-provisions";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { workspaceResourceSetUpdates } from "@/api/lib/resource-set-realtime";

export const createLegislationMatterLinksBatchBodySchema = v.strictObject({
  items: v.pipe(
    v.array(legislationMatterLinkItemSchema),
    v.minLength(1),
    v.maxLength(LIMITS.legislationMatterLinksPerWorkspace),
  ),
});
const config = {
  contract: "patch",
  idempotency: { type: "replay" },
  description:
    "Link a selection of statute provisions and their exact applied consolidations to the current matter in one transaction. The idempotent response partitions every request into linked, existing, or rejected with a typed reason.",
  permissions: { entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  realtime: workspaceResourceSetUpdates(RESOURCE_TYPE.WORKSPACE),
  mcp: {
    type: "capability",
    reason: "legal_corpus_admin",
    consumesServices: false,
  },
  body: createLegislationMatterLinksBatchBodySchema,
} satisfies WorkspaceHandlerConfig;
export const createLegislationMatterLinksBatchHandler = (
  legislationDb: LegislationReadDb,
) =>
  createSafeHandler(
    config,
    async function* ({
      body,
      recordAuditEvent,
      safeDb,
      session,
      user,
      workspaceId,
    }) {
      const provisions = yield* Result.await(
        Result.tryPromise(
          async () =>
            await resolveMatterLinkProvisions({
              items: body.items,
              legislationDb,
            }),
        ),
      );
      const outcome = yield* Result.await(
        safeDb(
          async (tx) =>
            await linkProvisionsToMatter({
              tx,
              workspaceId,
              userId: user.id,
              provisions,
              organizationId: session.activeOrganizationId,
              recordAuditEvent,
            }),
        ),
      );
      return Result.ok(outcome);
    },
  );

const createLegislationMatterLinksBatch =
  createLegislationMatterLinksBatchHandler(legislationPublicReadDb);

declareAggregateMutation(createLegislationMatterLinksBatch, {
  type: "aggregate",
  aggregates: ["workspace"],
});

export default createLegislationMatterLinksBatch;
