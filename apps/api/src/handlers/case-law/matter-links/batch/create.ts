import { Result } from "better-result";
import { t } from "elysia";

import { linkDecisionsToMatter } from "@/api/handlers/case-law/matter-links/link-writes";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

export const createMatterLinksBatchBodySchema = t.Object(
  {
    items: t.Array(
      t.Object(
        {
          decisionId: tSafeId("caseLawDecision"),
          note: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: LIMITS.caseLawMatterLinksPerWorkspace },
    ),
  },
  { additionalProperties: false },
);

const config = {
  description:
    "Link a selection of case-law decisions to the current matter in one " +
    "call, each with an optional note. Best effort and idempotent: the " +
    "response reports every decision asked for, under `linked` (newly " +
    "pinned), `existing` (already pinned, returned unchanged with the note " +
    "recorded earlier) or `rejected` with a reason — `not_found` for a " +
    "decision that is not in the corpus, `limit` for one that would push the " +
    "matter past its maximum number of links. A decision already pinned " +
    "never counts against that maximum. The whole call is one transaction: " +
    "either every link it reports lands, or none does. Repeat the call with " +
    "the same items safely; the second call reports them as `existing`. At " +
    "most as many items as the matter may hold links.",
  permissions: { entity: ["create"] },
  mcp: { type: "capability", reason: "legal_corpus_admin" },
  body: createMatterLinksBatchBodySchema,
} satisfies HandlerConfig;

const createMatterLinksBatch = createSafeHandler(
  config,
  async function* ({ body, recordAuditEvent, scopedDb, user, workspaceId }) {
    // One transaction for the whole selection: the cap is counted, decided and
    // spent under one per-matter lock, so two callers pinning near the cap
    // cannot both find room for the same remaining slots.
    const outcome = yield* Result.await(
      Result.tryPromise(
        async () =>
          await scopedDb(
            async (tx) =>
              await linkDecisionsToMatter({
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

export default createMatterLinksBatch;
