import { Result } from "better-result";
import * as v from "valibot";

import { legislationMatterLinkItemSchema } from "@/api/handlers/legislation/matter-links/create";
import { linkProvisionsToMatter } from "@/api/handlers/legislation/matter-links/link-writes";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

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
  mcp: {
    type: "capability",
    reason: "legal_corpus_admin",
    consumesServices: false,
  },
  body: createLegislationMatterLinksBatchBodySchema,
} satisfies WorkspaceHandlerConfig;
export default createSafeHandler(
  config,
  async function* ({ body, recordAuditEvent, scopedDb, user, workspaceId }) {
    const outcome = yield* Result.await(
      Result.tryPromise(
        async () =>
          await scopedDb(
            async (tx) =>
              await linkProvisionsToMatter({
                tx,
                workspaceId,
                userId: user.id,
                items: body.items,
                recordAuditEvent,
              }),
          ),
      ),
    );
    return Result.ok(outcome);
  },
);
