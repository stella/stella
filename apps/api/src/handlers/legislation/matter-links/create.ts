import { panic, Result } from "better-result";
import * as v from "valibot";

import { linkProvisionsToMatter } from "@/api/handlers/legislation/matter-links/link-writes";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";

export const legislationMatterLinkItemSchema = v.strictObject({
  statuteId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  provisionId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  version: v.pipe(v.string(), v.isoDate()),
  jurisdiction: v.pipe(v.string(), v.minLength(3), v.maxLength(3)),
});
export const createLegislationMatterLinkBodySchema =
  legislationMatterLinkItemSchema;

const responseForOutcome = (
  outcome: Awaited<ReturnType<typeof linkProvisionsToMatter>>,
) => {
  const link = outcome.linked.at(0) ?? outcome.existing.at(0);
  if (link !== undefined) {
    return link;
  }
  const rejection =
    outcome.rejected.at(0) ?? panic("Legislation matter link had no outcome");
  switch (rejection.reason) {
    case "not_found":
      return status(404, {
        code: "LEGISLATION_PROVISION_NOT_FOUND",
        message: "Statute provision version not found",
      });
    case "out_of_jurisdiction":
      return status(400, {
        code: "LEGISLATION_JURISDICTION_NOT_SUPPORTED",
        message: "Legislation jurisdiction is not supported",
      });
    case "limit":
      return status(400, {
        code: "MATTER_LINK_LIMIT_REACHED",
        message: "Matter links limit reached",
      });
    default:
      rejection.reason satisfies never;
      return panic("Unhandled legislation matter-link rejection");
  }
};

const config = {
  contract: "patch",
  idempotency: { type: "replay" },
  description:
    "Link one statute provision and the exact applied consolidation to the current matter. Pass the statute identifier, provision identifier, version date and jurisdiction returned by the legislation tools. Repeating the same link returns the existing row unchanged.",
  permissions: { entity: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  mcp: {
    type: "capability",
    reason: "legal_corpus_admin",
    consumesServices: false,
  },
  body: createLegislationMatterLinkBodySchema,
} satisfies WorkspaceHandlerConfig;

export const createLegislationMatterLink = createSafeHandler(
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
                items: [body],
                recordAuditEvent,
              }),
          ),
      ),
    );
    return Result.ok(responseForOutcome(outcome));
  },
);
export default createLegislationMatterLink;
