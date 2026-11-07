import * as v from "valibot";

import {
  readsSharedPublicLawCorpus,
  STORED_ONLY_DOCUMENT_HYDRATION,
} from "@/api/handlers/case-law/decisions/get-deferred-document";
import { verifyDecisionQuotation } from "@/api/handlers/case-law/decisions/quotes/verification";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";
import { projectResponseText } from "@/api/lib/search/project-response-text";

import { nullAsAbsent, uuidInputSchema } from "./input-schemas";
import {
  defaultReadGatedDecisionWithDocument,
  isReadCaseLawDecisionSuccess,
} from "./public-law-handlers";
import { defineMcpToolSet } from "./tool-types";
import type { TypedMcpToolHandler } from "./tool-types";
import {
  handlerStatusOf,
  notFoundResult,
  structuredErrorResult,
  toolDataResult,
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

// A quote's text and its passage: the longest quote at three UTF-8 bytes per
// UTF-16 unit, with room for the whitespace the comparison collapses. A longer
// stored span is cut in its text field; its offsets still address all of it.
const QUOTE_TEXT_MAX_BYTES = 16_384;
// `boundedString` without its runtime check, which an MCP output schema cannot
// publish. Both surfaces project this contract, which enforces the byte bound
// and well-formed text, before the schema reads the answer.
const boundedString = (maxBytes: number) =>
  v.pipe(
    v.string(),
    v.maxLength(maxBytes),
    v.metadata({ "x-maxUtf8Bytes": maxBytes }),
  );
const QUOTE_WORD_MAX_BYTES = 1024;
const decisionIdSchema = boundedString(64);
const textSourceSchema = v.picklist(["ast", "fulltext"]);
const segmentsSchema = <T extends v.GenericSchema>(segment: T) =>
  v.pipe(v.array(segment), v.maxLength(LIMITS.caseLawQuoteMaxSegments));
const passageSchema = v.object({
  start: v.number(),
  end: v.number(),
  text: boundedString(QUOTE_TEXT_MAX_BYTES),
  paragraphs: v.pipe(
    v.array(
      v.object({
        position: v.number(),
        label: v.nullable(boundedString(256)),
        headingPath: v.pipe(
          v.array(boundedString(1024)),
          v.maxLength(LIMITS.caseLawQuoteMaxHeadingDepth),
        ),
        url: v.exactOptional(boundedString(4096)),
      }),
    ),
    v.maxLength(LIMITS.caseLawQuoteMaxPassageParagraphs),
  ),
});
// An alignment spends at most one edit per quote token, so a closest passage
// holds at most twice the quote's tokens, and its differences list each passage
// and quote token at most once.
const QUOTE_DIFFERENCE_MAX_WORDS = 3 * LIMITS.caseLawQuoteMaxTokens;
const closestSchema = v.object({
  ...passageSchema.entries,
  similarity: v.number(),
  differences: v.pipe(
    v.array(
      v.object({
        type: v.picklist(["equal", "added", "dropped"]),
        words: v.pipe(
          v.array(boundedString(QUOTE_WORD_MAX_BYTES)),
          v.maxLength(QUOTE_DIFFERENCE_MAX_WORDS),
        ),
      }),
    ),
    v.maxLength(QUOTE_DIFFERENCE_MAX_WORDS),
  ),
});
export const verifyQuoteOutputSchema = v.variant("status", [
  v.object({
    status: v.literal("exact"),
    verified: v.literal(true),
    decisionId: decisionIdSchema,
    textSource: textSourceSchema,
    segments: segmentsSchema(
      v.object({
        text: boundedString(QUOTE_TEXT_MAX_BYTES),
        occurrenceCount: v.number(),
        occurrences: v.pipe(
          v.array(passageSchema),
          v.maxLength(LIMITS.caseLawQuoteMaxOccurrences),
        ),
      }),
    ),
  }),
  // Before the picklist below: text projection picks a branch by its constants.
  v.object({
    status: v.literal("cannot_verify"),
    verified: v.literal(false),
    decisionId: decisionIdSchema,
    textState: v.picklist([
      "pending",
      "unavailable",
      "withheld",
      "failed",
      "empty",
    ]),
    hint: boundedString(512),
  }),
  v.object({
    status: v.picklist(["fuzzy", "not_found"]),
    verified: v.literal(false),
    decisionId: decisionIdSchema,
    textSource: textSourceSchema,
    segments: segmentsSchema(
      v.object({
        text: boundedString(QUOTE_TEXT_MAX_BYTES),
        closest: v.nullable(closestSchema),
      }),
    ),
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
    projectResponseText(
      verifyDecisionQuotation({
        read,
        quote,
        readSharedCorpus:
          context.testDependencies?.readsSharedPublicLawCorpus ??
          readsSharedPublicLawCorpus,
      }),
      verifyQuoteOutputSchema,
    ),
  );
};

export const VERIFY_QUOTE_TOOL_SET = defineMcpToolSet(
  definitions,
  { verify_quote: handleVerifyQuote },
  { verify_quote: defineMcpToolOutput(verifyQuoteOutputSchema) },
);
