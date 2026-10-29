import * as v from "valibot";

import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";

import {
  decisionDocumentState,
  readsSharedPublicLawCorpus,
  STORED_ONLY_DOCUMENT_HYDRATION,
} from "@/api/handlers/case-law/decisions/get-deferred-document";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedCaseLawDecisionId } from "@/api/lib/safe-id-boundaries";

import type { LocatedDecisionBlock } from "./case-law-decision-outline";
import { locateDecisionBlocks } from "./case-law-decision-outline";
import { decisionParagraphs } from "./case-law-decision-read";
import {
  defaultReadGatedDecisionWithDocument,
  isReadCaseLawDecisionSuccess,
} from "./public-law-handlers";
import { defineMcpToolSet } from "./tool-types";
import type { TypedMcpToolHandler } from "./tool-types";
import {
  buildCaseLawDecisionAppUrl,
  handlerStatusOf,
  notFoundResult,
  nullAsAbsent,
  structuredErrorResult,
  toolDataResult,
  toPlainCorpusText,
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
  verifyQuote,
} from "./verify-quote.logic";
import { openMcpRead } from "./write-tool-authority";

export const verifyQuoteArgsSchema = nullAsAbsent(
  v.strictObject({
    decision_id: uuidInputSchema(
      "Decision ID from search_case_law or resolve_case_law_decision.",
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
        `Quote to check: at most ${LIMITS.caseLawQuoteMaxChars} characters, ${LIMITS.caseLawQuoteMaxTokens} total word/punctuation tokens and ${LIMITS.caseLawQuoteMaxSegments} nonempty segments. Ellipses (..., …, […], (...)) separate ordered segments. Case-sensitive; diacritics are preserved.`,
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
      url: v.optional(v.string()),
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
    description: `Check whether a quote occurs in one stored decision. Resolve docket/ECLI with resolve_case_law_decision first. Exact preserves wording/case/diacritics, normalizing whitespace, quotation marks, dashes, soft/line-end hyphens and č. j. spacing; returns every occurrence in ordered ellipsis segments, with paragraph labels and links. Only exact is verified:true. Report fuzzy as an altered quote, never confirmed. Fuzzy returns a closest token-edit passage and similarity >= ${QUOTE_FUZZY_THRESHOLD}; not_found is lower. Differences run passage to quote: added/dropped tokens show alterations. Cannot_verify means unreadable text, never absence of a quote. Offsets are original UTF-16 units. No publisher fetch. Use read_case_law_decision for context.`,
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
  const state = decisionDocumentState(
    read,
    (
      context.testDependencies?.readsSharedPublicLawCorpus ??
      readsSharedPublicLawCorpus
    )(),
  );
  if (
    !read.source.allowsDerivedAi ||
    state !== "available" ||
    read.documentReadFailed
  ) {
    return toolDataResult({
      status: "cannot_verify",
      verified: false,
      decisionId: read.id,
      textState: (() => {
        if (!read.source.allowsDerivedAi) {
          return "withheld" as const;
        }
        if (read.documentReadFailed) {
          return "failed" as const;
        }
        return state === "pending"
          ? ("pending" as const)
          : ("unavailable" as const);
      })(),
      hint: "Open the publisher document through read_case_law_decision; retry verify_quote after stored text becomes available.",
    });
  }
  const parsedBlocks =
    parseCaseLawDecisionAst(read.documentAst)?.blocks ?? null;
  const astText =
    parsedBlocks === null
      ? null
      : toPlainCorpusText({ blocks: parsedBlocks, fulltext: null });
  const blocks = astText !== null && astText.length > 0 ? parsedBlocks : null;
  const text = blocks === null ? read.fulltext : astText;
  if (text === null || text.trim().length === 0) {
    return toolDataResult({
      status: "cannot_verify",
      verified: false,
      decisionId: read.id,
      textState: "empty",
      hint: "Use read_case_law_decision to inspect metadata and the publisher URL; no stored text can verify this quote.",
    });
  }
  const url = buildCaseLawDecisionAppUrl({
    decisionId: read.id,
    caseNumber: read.caseNumber,
    country: read.country,
    court: read.court,
    language: read.language,
    languageAlternates: read.languageAlternates,
    slug: read.slug,
  });
  let offset = 0;
  const located: LocatedDecisionBlock[] =
    blocks === null
      ? decisionParagraphs({ located: null, text }).map((paragraph) => {
          const start = text.indexOf(paragraph.text, offset);
          offset = start + paragraph.text.length;
          return { ...paragraph, start, end: offset, type: "paragraph" };
        })
      : locateDecisionBlocks(blocks, text);
  return toolDataResult({
    decisionId: read.id,
    textSource: blocks === null ? "fulltext" : "ast",
    ...verifyQuote({ text, quote, located, url }),
  });
};

export const VERIFY_QUOTE_TOOL_SET = defineMcpToolSet(
  definitions,
  { verify_quote: handleVerifyQuote },
  { verify_quote: defineMcpToolOutput(verifyQuoteOutputSchema) },
);
