import * as v from "valibot";

import {
  DECISION_ANCHOR_MAX_LENGTH,
  DECISION_ANCHOR_REDIRECT_MAX_ANCHORS,
  decisionAnchorRedirectsResponseSchema,
} from "@stll/api-contract/case-law-anchor-redirects";

import { createSafePublicSubjectHandler } from "@/api/handlers/case-law/decisions/public-subject";
import {
  ACCOUNT_ACCESS,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import type { PublicHandlerConfig } from "@/api/lib/api-handlers";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { readDecisionAnchorRedirects } from "@/api/lib/case-law/decision-anchor-redirects";
import { resourceIdSchema } from "@/api/lib/custom-schema";

/** Comma-separated anchors, as a fragment or a stored link carries them. */
const anchorsQuerySchema = v.pipe(
  v.string(),
  v.transform((value) => [
    ...new Set(
      value
        .split(",")
        .map((anchor) => anchor.trim())
        .filter((anchor) => anchor.length > 0),
    ),
  ]),
  v.minLength(1, "Name at least one anchor"),
  v.maxLength(
    DECISION_ANCHOR_REDIRECT_MAX_ANCHORS,
    `Name at most ${String(DECISION_ANCHOR_REDIRECT_MAX_ANCHORS)} anchors`,
  ),
  v.check(
    (anchors) =>
      anchors.every((anchor) => anchor.length <= DECISION_ANCHOR_MAX_LENGTH),
    `An anchor is at most ${String(DECISION_ANCHOR_MAX_LENGTH)} characters`,
  ),
);

const config = {
  contract: "patch",
  cache: { kind: "none" },
  response: safePublicHandlerResponseSchemasWithStatusText(
    decisionAnchorRedirectsResponseSchema,
  ),
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "public_indexing" },
  params: v.object({ decisionId: resourceIdSchema("caseLawDecision") }),
  query: v.object({ anchors: anchorsQuerySchema }),
} satisfies PublicHandlerConfig;

/**
 * Where block anchors of an earlier version of the decision's document went.
 * The caller combines each answer with the document it holds
 * (`resolveDecisionAnchor` in the API contract).
 */
export const createReadDecisionAnchorRedirectsHandler = (
  caseLawDb: CaseLawPublicReadDb = caseLawPublicReadDb,
) =>
  createSafePublicSubjectHandler({
    config,
    caseLawDb,
    locate: ({ params: { decisionId } }) => ({ kind: "id", id: decisionId }),
    read: async ({ id, tx }, { query: { anchors } }) => ({
      items: await readDecisionAnchorRedirects(tx, {
        decisionId: id,
        anchors,
      }),
    }),
  });

const readDecisionAnchorRedirectsRoute =
  createReadDecisionAnchorRedirectsHandler();

export default readDecisionAnchorRedirectsRoute;
