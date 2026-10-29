import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";

import {
  decisionDocumentState,
  readsSharedPublicLawCorpus,
} from "@/api/handlers/case-law/decisions/get-deferred-document";
import type { LocatedDecisionBlock } from "@/api/mcp/case-law-decision-outline";
import { locateDecisionBlocks } from "@/api/mcp/case-law-decision-outline";
import { decisionParagraphs } from "@/api/mcp/case-law-decision-read";
import type { ReadCaseLawDecisionSuccess } from "@/api/mcp/public-law-handlers";
import {
  buildCaseLawDecisionAppUrl,
  toPlainCorpusText,
} from "@/api/mcp/tool-utils";
import { verifyQuote } from "@/api/mcp/verify-quote.logic";

type VerifyDecisionQuotationOptions = {
  read: ReadCaseLawDecisionSuccess;
  quote: string;
  readSharedCorpus?: typeof readsSharedPublicLawCorpus;
};

export const verifyDecisionQuotation = ({
  read,
  quote,
  readSharedCorpus = readsSharedPublicLawCorpus,
}: VerifyDecisionQuotationOptions) => {
  const state = decisionDocumentState(read, readSharedCorpus());
  if (
    !read.source.allowsDerivedAi ||
    state !== "available" ||
    read.documentReadFailed
  ) {
    return {
      status: "cannot_verify" as const,
      verified: false as const,
      decisionId: read.id.toString(),
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
    };
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
    return {
      status: "cannot_verify" as const,
      verified: false as const,
      decisionId: read.id.toString(),
      textState: "empty" as const,
      hint: "Use read_case_law_decision to inspect metadata and the publisher URL; no stored text can verify this quote.",
    };
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
  return {
    decisionId: read.id.toString(),
    textSource: blocks === null ? ("fulltext" as const) : ("ast" as const),
    ...verifyQuote({ text, quote, located, url }),
  };
};
