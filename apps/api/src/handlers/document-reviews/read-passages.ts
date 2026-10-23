/**
 * The words behind reference passages, by id.
 *
 * This is the only endpoint that returns reference text. Every other surface
 * (a proposal, a run, a finding, a playbook) carries passage ids, and a client
 * that wants to show the quote asks here. The read runs in the caller's own
 * scoped transaction, so `document_review_reference_passages` row security
 * answers only the passages whose matter the caller can open; an id the
 * caller may not read is simply absent, indistinguishable from one that does
 * not exist. Root-scoped rather than matter-scoped because a playbook, which
 * is organization-wide, quotes passages from matters of its own.
 */

import { Result } from "better-result";
import * as v from "valibot";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { readReferencePassageTexts } from "@/api/lib/document-review/reference-passages";

const config = {
  contract: "patch",
  description:
    "Read the text of reference passages by id. Answers only the passages whose matter the caller can open; every other review surface carries passage ids and reads their words here.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "document_processing" },
  body: v.object({
    ids: v.pipe(
      v.array(resourceIdSchema("documentReviewReferencePassage")),
      v.minLength(1),
      v.maxLength(DOCUMENT_REVIEW_LIMITS.passageReadMax),
    ),
  }),
} satisfies HandlerConfig;

const readDocumentReviewPassages = createSafeRootHandler(
  config,
  async function* ({ body: { ids }, safeDb }) {
    const textById = yield* Result.await(
      safeDb(async (tx) => await readReferencePassageTexts(tx, ids)),
    );
    return Result.ok({
      passages: [...textById].map(([id, text]) => ({ id, text })),
    });
  },
);

export default readDocumentReviewPassages;
