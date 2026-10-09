import { panic } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import {
  parseDecisionQuery,
  resolveDecisionIdentity,
} from "@stll/api-contract/decision-query-intent";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import {
  isPublicCountry,
  PUBLIC_COUNTRY_CAPABILITIES,
} from "@stll/api-contract/public-country-capability";
import { decisionReporterGrammarForJurisdiction } from "@stll/api-contract/us-reporter-citation";
import { parseCaseLawDecisionAst } from "@stll/legal-ast/case-law-reader";
import type { Block } from "@stll/legal-ast/document-ast";

import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import {
  decisionIdentityLocatorOf,
  lookupDecisionsByIdentity,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import type { LawReadAdmission } from "@/api/handlers/legal-resolve/admission";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import { buildCaseLawDecisionUrl } from "@/api/lib/legal-search/public-law-app-urls";
import { LIMITS } from "@/api/lib/limits";
import {
  MCP_CONTENT_MAX_CHARS,
  resolveTextWindowBounds,
  toPlainCorpusText,
} from "@/api/mcp/tool-utils";

type DecisionResolverDependencies = {
  lookup?: typeof lookupDecisionsByIdentity;
  read?: typeof readDecisionReaderSource;
};

type ResolvedDecisionDocument = Extract<
  Extract<LegalResolveResponse, { status: "resolved" }>["document"],
  { kind: "decision" }
>;

const decisionText = (
  content: Awaited<ReturnType<typeof readDecisionReaderSource>>,
): ResolvedDecisionDocument["text"] => {
  if (content?.status !== "read") {
    return { status: "unavailable" };
  }
  if (content.textAccess === "readable") {
    // A published decision can be readable yet bodyless (redacted or not
    // yet fetched); that is missing text, not an empty decision.
    const blocks = parseCaseLawDecisionAst(content.ast)?.blocks ?? [];
    if (blocks.length === 0) {
      return { status: "unavailable" };
    }
    const totalChars =
      toPlainCorpusText({ blocks, fulltext: null })?.length ?? 0;
    if (totalChars <= MCP_CONTENT_MAX_CHARS) {
      return {
        status: "readable",
        blocks,
        extent: { type: "complete" },
      };
    }

    const returnedBlocks: Block[] = [];
    let returnedChars = 0;
    for (const block of blocks) {
      const separatorChars =
        returnedChars > 0 && block.plainText !== "" ? 2 : 0;
      const candidateChars =
        returnedChars + separatorChars + block.plainText.length;
      if (candidateChars > MCP_CONTENT_MAX_CHARS) {
        if (returnedChars === 0) {
          const { end } = resolveTextWindowBounds({
            text: block.plainText,
            offset: 0,
            size: MCP_CONTENT_MAX_CHARS,
          });
          const text = block.plainText.slice(0, end);
          switch (block.type) {
            case "heading":
            case "paragraph":
              returnedBlocks.push({
                ...block,
                inlines: [{ type: "text", text }],
                plainText: text,
              });
              break;
            case "table":
              returnedBlocks.push({
                ...block,
                rows: [
                  [{ inlines: [{ type: "text", text }], plainText: text }],
                ],
                plainText: text,
              });
              break;
            case "image":
              returnedBlocks.push({ ...block, alt: text, plainText: text });
              break;
            default:
              block satisfies never;
              return panic("Unhandled decision block type");
          }
          returnedChars = text.length;
        }
        break;
      }
      returnedBlocks.push(block);
      returnedChars = candidateChars;
    }
    return {
      status: "readable",
      blocks: returnedBlocks,
      extent: { type: "partial", returnedChars, totalChars },
    };
  }
  return { status: "withheld", reason: "licence" };
};

const candidate = (row: DecisionIdentityRow) => ({
  decisionId: row.id,
  identifier: row.ecli ?? row.caseNumber,
  label: `${row.court}, ${row.decisionDate ?? row.caseNumber}`,
  readerUrl: buildCaseLawDecisionUrl({
    caseNumber: row.caseNumber,
    country: row.country,
    court: row.court,
    decisionId: row.id,
    language: row.language,
    languageAlternates: row.languageAlternates,
    slug: row.slug,
  }),
});

type ResolveDecisionOptions = {
  admission: LawReadAdmission;
  country: string;
  identifier: string;
  dependencies?: DecisionResolverDependencies;
};

export const resolveDecision = async ({
  admission: _admission,
  country: countryInput,
  identifier,
  dependencies: {
    lookup = lookupDecisionsByIdentity,
    read = readDecisionReaderSource,
  } = {},
}: ResolveDecisionOptions): Promise<LegalResolveResponse> => {
  if (identifier.trim().length === 0) {
    return { status: "incomplete_identifier", missing: ["identifier"] };
  }
  const normalized = normalizeCountry(countryInput);
  if (!normalized.ok) {
    return { status: "not_found", reason: "no_exact_identity" };
  }
  const country = normalized.value.alpha3;
  if (!isPublicCountry(country)) {
    return { status: "country_unavailable" };
  }
  if (PUBLIC_COUNTRY_CAPABILITIES[country] !== "admitted") {
    return { status: "country_unavailable" };
  }
  const grammar = decisionDocketGrammarForCountry(country);
  const reporters = decisionReporterGrammarForJurisdiction(country);
  const intent = parseDecisionQuery(identifier, { grammar, reporters });
  if (intent.type !== "identifier") {
    return { status: "not_found", reason: "no_exact_identity" };
  }
  const rows = await lookup({
    caseLawDb: caseLawPublicReadDb,
    country,
    locator: decisionIdentityLocatorOf(intent),
  });
  const resolution = resolveDecisionIdentity(intent, rows, { reporters });
  switch (resolution.status) {
    case "none":
      return { status: "not_found", reason: "no_exact_identity" };
    case "ambiguous":
      if (resolution.reason === "selector_unmatched") {
        return { status: "not_found", reason: "no_exact_identity" };
      }
      return {
        status: "ambiguous",
        candidates: resolution.candidates
          .slice(0, LIMITS.caseLawLookupCandidatesMax)
          .map(candidate),
      };
    case "unique": {
      const row = resolution.decision;
      const content = await read({
        decisionId: row.id,
        phase: "blocks",
        audience: "model",
      });
      const readerUrl = buildCaseLawDecisionUrl({
        caseNumber: row.caseNumber,
        country: row.country,
        court: row.court,
        decisionId: row.id,
        language: row.language,
        languageAlternates: row.languageAlternates,
        slug: row.slug,
      });
      return {
        status: "resolved",
        document: {
          kind: "decision",
          decisionId: row.id,
          identifier: row.ecli ?? row.caseNumber,
          country: row.country,
          caseNumber: row.caseNumber,
          court: row.court,
          decisionDate: row.decisionDate,
          ecli: row.ecli,
          readerUrl,
          text: decisionText(content),
        },
      };
    }
    default:
      resolution satisfies never;
      return panic("Unhandled decision identity resolution");
  }
};
