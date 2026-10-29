import * as v from "valibot";

import {
  readsSharedPublicLawCorpus,
  STORED_ONLY_DOCUMENT_HYDRATION,
} from "@/api/handlers/case-law/decisions/get-deferred-document";
import { verifyDecisionQuotation } from "@/api/handlers/case-law/decisions/quotes/verification";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

import {
  defaultReadGatedDecisionWithDocument,
  isReadCaseLawDecisionSuccess,
} from "./public-law-handlers";
import { defineMcpToolSet } from "./tool-types";
import type { TypedMcpToolHandler } from "./tool-types";
import {
  handlerStatusOf,
  notFoundResult,
  nullAsAbsent,
  structuredErrorResult,
  toolDataResult,
  uuidInputSchema,
  validationErrorResult,
} from "./tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "./valibot-tool-definition";
import {
  QUOTE_FUZZY_THRESHOLD,
  quoteInputWithinBudget,
} from "./verify-quote.logic";
import { openMcpRead } from "./write-tool-authority";

export const verifyQuoteArgsSchema = nullAsAbsent(
  v.strictObject({
    decision_id: uuidInputSchema(
      "ID from search_case_law or resolve_case_law_decision.",
    ),
    text: v.pipe(
      v.string(),
      v.nonEmpty(),
      v.maxLength(LIMITS.caseLawQuoteMaxChars),
      v.check(
        quoteInputWithinBudget,
        `Supply nonempty quote segments, at most ${LIMITS.caseLawQuoteMaxSegments} segments and ${LIMITS.caseLawQuoteMaxTokens} total word/punctuation tokens.`,
      ),
      v.description(
        `Quote: max ${LIMITS.caseLawQuoteMaxChars} chars, ${LIMITS.caseLawQuoteMaxTokens} word/punctuation tokens, ${LIMITS.caseLawQuoteMaxSegments} nonempty ordered segments split by ..., …, […] or (...). Preserve case/diacritics.`,
      ),
    ),
  }),
);

const passageSchema = v.object({
  start: v.number(),
  end: v.number(),
  text: v.string(),
  paragraphs: v.array(
    v.object({
      position: v.number(),
      label: v.nullable(v.string()),
      headingPath: v.array(v.string()),
      url: v.exactOptional(v.string()),
    }),
  ),
});
const closestSchema = v.object({
  ...passageSchema.entries,
  similarity: v.number(),
  differences: v.array(
    v.object({
      type: v.picklist(["equal", "added", "dropped"]),
      words: v.array(v.string()),
    }),
  ),
});
export const verifyQuoteOutputSchema = v.variant("status", [
  v.object({
    status: v.literal("exact"),
    verified: v.literal(true),
    decisionId: v.string(),
    textSource: v.picklist(["ast", "fulltext"]),
    segments: v.array(
      v.object({ text: v.string(), occurrences: v.array(passageSchema) }),
    ),
  }),
  v.object({
    status: v.picklist(["fuzzy", "not_found"]),
    verified: v.literal(false),
    decisionId: v.string(),
    textSource: v.picklist(["ast", "fulltext"]),
    segments: v.array(
      v.object({ text: v.string(), closest: v.nullable(closestSchema) }),
    ),
  }),
  v.object({
    status: v.literal("cannot_verify"),
    verified: v.literal(false),
    decisionId: v.string(),
    textState: v.picklist([
      "pending",
      "unavailable",
      "withheld",
      "failed",
      "empty",
    ]),
    hint: v.string(),
  }),
]);

const definitions = [
  defineValibotMcpTool({
    name: "verify_quote",
    consumesServices: false,
    annotations: {
      title: "Verify a decision quotation",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description: `Check a quote in one stored decision; resolve docket/ECLI with resolve_case_law_decision first. Exact preserves wording/case/diacritics, normalizes whitespace, quotes, dashes, soft/line-end hyphens and č. j. spacing; returns all occurrences per ordered ellipsis segment, paragraph labels/links and original UTF-16 offsets. Only exact: verified:true; all others:false. Report fuzzy as an altered quote, never confirmed: closest token-edit passage, similarity >= ${QUOTE_FUZZY_THRESHOLD}; not_found: lower. Differences go passage→quote (added/dropped tokens). cannot_verify: unreadable text, not quote absence. No publisher fetch; read_case_law_decision gives context.`,
    inputSchema: verifyQuoteArgsSchema,
    jsonSchemaProjectionWaiver: {
      ignoreActions: ["check"],
      reason:
        "Token and ellipsis budgets require normalization; the shared runtime schema enforces the documented limits.",
    },
    access: "read",
    permissions: openMcpRead("public case-law corpus"),
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
    scope: "stella:read",
  }),
] as const;

const handleVerifyQuote: TypedMcpToolHandler<
  v.InferOutput<typeof verifyQuoteOutputSchema>
> = async ({ args, context }) => {
  const parsed = v.safeParse(verifyQuoteArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(
      parsed.issues,
      "Call verify_quote with a decision_id from search_case_law or resolve_case_law_decision and text within the documented quote limits.",
    );
  }
  const { decision_id: decisionId, text: quote } = parsed.output;
  const read = await (
    context.testDependencies?.readGatedDecisionWithDocument ??
    defaultReadGatedDecisionWithDocument
  )({
    caseLawDb: caseLawPublicReadDb,
    locator: { kind: "id", id: brandPersistedCaseLawDecisionId(decisionId) },
    citationsCursor: null,
    caller: "attributed",
    documentHydration: STORED_ONLY_DOCUMENT_HYDRATION,
    surface: "identity",
  });
  if (read === null || handlerStatusOf(read)?.code === 404) {
    return notFoundResult(
      "Decision not found",
      "Pass decisionId from search_case_law or resolve_case_law_decision.",
    );
  }
  if (!isReadCaseLawDecisionSuccess(read)) {
    return structuredErrorResult({
      code: "upstream_unavailable",
      message: "The stored decision could not be read.",
      hint: "Retry verify_quote with the same decision_id; use read_case_law_decision to inspect its availability.",
      retryable: true,
    });
  }
  return toolDataResult(
    verifyDecisionQuotation({
      read,
      quote,
      readSharedCorpus:
        context.testDependencies?.readsSharedPublicLawCorpus ??
        readsSharedPublicLawCorpus,
    }),
  );
};

export const VERIFY_QUOTE_TOOL_SET = defineMcpToolSet(
  definitions,
  { verify_quote: handleVerifyQuote },
  { verify_quote: defineMcpToolOutput(verifyQuoteOutputSchema) },
);
