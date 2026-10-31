import { panic, Result } from "better-result";
import * as v from "valibot";

import { agentInputNormalization } from "@stll/agent-input";
import { RESOURCE_TYPE } from "@stll/api-contract";

import { linkProvisionsToMatter } from "@/api/handlers/legislation/matter-links/link-writes";
import { status } from "@/api/http/status";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { resolveMatterLinkProvisions } from "@/api/lib/legal-search/legislation-matter-link-provisions";
import { tPublicLawCountry } from "@/api/lib/legal-search/public-law-country";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { workspaceResourceSetUpdates } from "@/api/lib/resource-set-realtime";

export const legislationMatterLinkItemSchema = v.strictObject({
  statuteId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  provisionId: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  version: v.pipe(v.string(), v.isoDate()),
  jurisdiction: v.pipe(
    tPublicLawCountry,
    v.metadata(
      agentInputNormalization({
        kind: "country",
        country: { spelling: "alpha-3" },
      }),
    ),
  ),
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
    case "ambiguous_version":
      return status(409, {
        code: "LEGISLATION_VERSION_AMBIGUOUS",
        message:
          "Multiple statute language or source versions match this request",
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
  realtime: workspaceResourceSetUpdates(RESOURCE_TYPE.WORKSPACE),
  mcp: {
    type: "capability",
    reason: "legal_corpus_admin",
    consumesServices: false,
  },
  body: createLegislationMatterLinkBodySchema,
} satisfies WorkspaceHandlerConfig;

export const createLegislationMatterLinkHandler = (
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
              items: [body],
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
      return Result.ok(responseForOutcome(outcome));
    },
  );

export const createLegislationMatterLink = createLegislationMatterLinkHandler(
  legislationPublicReadDb,
);

declareAggregateMutation(createLegislationMatterLink, {
  type: "aggregate",
  aggregates: ["workspace"],
});

export default createLegislationMatterLink;
