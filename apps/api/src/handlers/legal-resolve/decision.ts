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
  PUBLIC_COUNTRY_SURFACE_OPEN,
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
import {
  readDecisionReviews,
  requireDecisionReviews,
} from "@/api/lib/case-law/decision-reviews";
import { CASE_LAW_SURFACE_COUNTRIES } from "@/api/lib/case-law/public-subject";
import { servedBlockText } from "@/api/lib/case-law/served-paragraph-number";
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
  readReviews?: typeof readDecisionReviews;
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
    const document = parseCaseLawDecisionAst(content.ast);
    if (document === null || document.blocks.length === 0) {
      return { status: "unavailable" };
    }
    const { blocks } = document;
    const plainText = toPlainCorpusText({ blocks, fulltext: null });
    if (plainText === null) {
      return { status: "unavailable" };
    }
    const totalChars = plainText.length;
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
      // Counted as the served text prints the block, number and all, so the
      // extent agrees with `totalChars`.
      const candidateChars =
        returnedChars +
        separatorChars +
        (block.plainText === "" ? 0 : servedBlockText(block).length);
      if (candidateChars > MCP_CONTENT_MAX_CHARS) {
        if (returnedChars === 0) {
          // The number the served text prints before the block shares the
          // window with its words.
          const numberChars =
            servedBlockText(block).length - block.plainText.length;
          const { end } = resolveTextWindowBounds({
            text: block.plainText,
            offset: 0,
            size: MCP_CONTENT_MAX_CHARS - numberChars,
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
          returnedChars = text.length + numberChars;
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

/**
 * A candidate's label: court, kind of decision and date. One docket can
 * hold a judgment and the Advocate General's opinion on it, decided by the
 * same court, so without the kind two candidates differ only by date.
 */
const candidateLabel = (row: DecisionIdentityRow): string =>
  [row.court, row.decisionType, row.decisionDate ?? row.caseNumber]
    .filter((part) => part !== null && part !== "")
    .join(", ");

const candidate = (row: DecisionIdentityRow) => ({
  decisionId: row.id,
  identifier: row.ecli ?? row.caseNumber,
  label: candidateLabel(row),
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

type ResolvedDecisionOptions = {
  row: DecisionIdentityRow;
  read: typeof readDecisionReaderSource;
  readReviews: typeof readDecisionReviews;
};

const resolvedDecision = async ({
  row,
  read,
  readReviews,
}: ResolvedDecisionOptions): Promise<LegalResolveResponse> => {
  const content = await read({
    decisionId: row.id,
    phase: "blocks",
    audience: "model",
    surface: "identity",
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
      language: row.language,
      languageAlternates: row.languageAlternates.map(({ id, language }) => ({
        decisionId: id,
        language,
      })),
      ecli: row.ecli,
      readerUrl,
      text: decisionText(content),
      appealReviews:
        content?.status === "read"
          ? content.decision.appealReviews
          : requireDecisionReviews(
              await readReviews({
                decisionIds: [row.id],
                caseLawDb: caseLawPublicReadDb,
              }),
              row.id,
            ),
    },
  };
};

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
    readReviews = readDecisionReviews,
  } = {},
}: ResolveDecisionOptions): Promise<LegalResolveResponse> => {
  if (identifier.trim().length === 0) {
    return { status: "incomplete_identifier", missing: ["identifier"] };
  }
  const normalized = normalizeCountry(countryInput);
  if (!normalized.ok) {
    return { status: "country_unavailable" };
  }
  const country = normalized.value.alpha3;
  if (!isPublicCountry(country)) {
    return { status: "country_unavailable" };
  }
  if (
    !PUBLIC_COUNTRY_SURFACE_OPEN.identity[
      PUBLIC_COUNTRY_CAPABILITIES[country].caseLaw
    ]
  ) {
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
    countries: CASE_LAW_SURFACE_COUNTRIES.identity,
    locator: decisionIdentityLocatorOf(intent),
  });
  const resolution = resolveDecisionIdentity(intent, rows, { reporters });
  switch (resolution.status) {
    case "none":
      return { status: "not_found", reason: "no_exact_identity" };
    case "ambiguous": {
      // A printed sheet no stored decision is known to carry. One decision
      // in the file is the one the reader asked for; several are left open.
      if (resolution.reason === "selector_unmatched") {
        // Only a printed sheet narrows the open candidates to decisions with
        // no recorded sheet; a part selector leaves the whole file open, so a
        // lone candidate may be a sibling under another part.
        const [only, ...rest] = resolution.candidates;
        const printedSheet =
          intent.kind === "docket" && intent.selector.kind === "sheet";
        return printedSheet && only !== undefined && rest.length === 0
          ? await resolvedDecision({ row: only, read, readReviews })
          : { status: "not_found", reason: "no_exact_identity" };
      }
      return {
        status: "ambiguous",
        candidates: resolution.candidates
          .slice(0, LIMITS.caseLawLookupCandidatesMax)
          .map(candidate),
      };
    }
    case "unique":
      return await resolvedDecision({
        row: resolution.decision,
        read,
        readReviews,
      });
    case "incomplete_identifier": {
      // A bare docket of a file that can hold several decisions. When the
      // lookup finds exactly one, that is the decision: asking for a sheet
      // the reader does not have only hides it. Several stay unresolved, and
      // exact identity never picks one of them for the caller.
      const [only, ...rest] = resolution.candidates;
      if (only !== undefined && rest.length === 0) {
        return await resolvedDecision({ row: only, read, readReviews });
      }
      return {
        status: "incomplete_identifier",
        missing: [...resolution.missing],
      };
    }
    default:
      resolution satisfies never;
      return panic("Unhandled decision identity resolution");
  }
};
