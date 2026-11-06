import { panic } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import {
  exactDecisionMatches,
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
import { compareByLocale, compareCodeUnit } from "@stll/collation";
import type { Block } from "@stll/legal-ast/document-ast";

import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import {
  decisionIdentityLocatorOf,
  lookupDecisionsByIdentity,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import type { LawReadAdmission } from "@/api/handlers/legal-resolve/admission";
import {
  admitResolvedDecision,
  atNamedCourt,
  decisionConstraints,
  type DecisionResolveResponse,
  namesCourt,
  namesUnrecognizedCourt,
  readDecisionCitation,
} from "@/api/handlers/legal-resolve/decision-constraints";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { parseCachedDecisionAst } from "@/api/lib/case-law/decision-ast-normalization";
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
    const document = parseCachedDecisionAst(content.ast);
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
    for (const [index, block] of blocks.entries()) {
      const served = servedBlockText(block, blocks[index - 1]);
      const separatorChars =
        returnedChars > 0 && block.plainText !== "" ? 2 : 0;
      // Counted as the served text prints the block, with its number and
      // note mark, so the extent agrees with `totalChars`.
      const candidateChars =
        returnedChars +
        separatorChars +
        (block.plainText === "" ? 0 : served.length);
      if (candidateChars > MCP_CONTENT_MAX_CHARS) {
        if (returnedChars === 0) {
          // The number or note mark the served text prints before the block
          // shares the window with its words.
          const numberChars = served.length - block.plainText.length;
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

/**
 * Other-court candidates in a stable order: court name in the docket's own
 * language, then decision date with undated decisions last, then id, so the
 * same docket always lists the same holders in the same places whatever order
 * the lookup returned them in.
 */
const compareDecisionDate = (
  left: string | null,
  right: string | null,
): number => {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  return compareCodeUnit(left, right);
};

const byCourtThenDate = (
  locale: string,
): ((left: DecisionIdentityRow, right: DecisionIdentityRow) => number) => {
  const compareCourt = compareByLocale(locale);
  return (left, right) =>
    compareCourt(left.court, right.court) ||
    compareDecisionDate(left.decisionDate, right.decisionDate) ||
    compareCodeUnit(left.id, right.id);
};

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

/**
 * The document of a decision. Only `admitResolvedDecision` turns it into a
 * resolved answer, once the decision has met every constraint.
 */
const decisionDocument = async (
  row: DecisionIdentityRow,
  read: typeof readDecisionReaderSource,
): Promise<ResolvedDecisionDocument> => {
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
  };
};

const otherCourtCandidate = (row: DecisionIdentityRow) => ({
  ...candidate(row),
  court: row.court,
  decisionDate: row.decisionDate,
  decisionType: row.decisionType,
  subjectSummary: row.subjectSummary ?? null,
});

type ResolveDecisionOptions = {
  admission: LawReadAdmission;
  country: string;
  identifier: string;
  dependencies?: DecisionResolverDependencies;
};

/**
 * Every answer the resolver gives is typed `DecisionResolveResponse`, whose
 * resolved member only `admitResolvedDecision` can make; the exported entry
 * point widens it to the wire type at the very end.
 */
const resolveConstrainedDecision = async ({
  admission: _admission,
  country: countryInput,
  identifier,
  dependencies: {
    lookup = lookupDecisionsByIdentity,
    read = readDecisionReaderSource,
  } = {},
}: ResolveDecisionOptions): Promise<DecisionResolveResponse> => {
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
  const parsed = parseDecisionQuery(identifier, { grammar, reporters });
  if (parsed.type !== "identifier") {
    return { status: "not_found", reason: "no_exact_identity" };
  }
  const { intent, courtText } = readDecisionCitation({
    country,
    identifier,
    intent: parsed,
    grammar,
    reporters,
  });
  const rows = await lookup({
    caseLawDb: caseLawPublicReadDb,
    country,
    countries: CASE_LAW_SURFACE_COUNTRIES.identity,
    locator: decisionIdentityLocatorOf(intent),
  });
  const named = namesCourt(
    decisionConstraints({
      country,
      intent,
      reporters,
      courtText,
      holders: rows,
    }),
  );
  // A sheet lookup intentionally does not load every member of a file.
  // Discover other courts through the indexed bare-family lookup while
  // retaining the exact read for selecting the requested decision.
  const docketRows =
    named && intent.kind === "docket" && intent.selector.kind !== "none"
      ? await lookup({
          caseLawDb: caseLawPublicReadDb,
          country,
          countries: CASE_LAW_SURFACE_COUNTRIES.identity,
          locator: {
            kind: "docket",
            value: intent.family,
            family: intent.family,
            selector: { kind: "none" },
          },
        })
      : [];
  const holders = [
    ...new Map([...rows, ...docketRows].map((row) => [row.id, row])).values(),
  ];
  // Read the court against the directory and every holder's stored court: a
  // court with no hit must still constrain the citation.
  const constraints = decisionConstraints({
    country,
    intent,
    reporters,
    courtText,
    holders,
  });
  const family = exactDecisionMatches(intent, holders, { reporters });
  const toOtherCourtCandidates = (
    holdersElsewhere: readonly DecisionIdentityRow[],
  ) =>
    holdersElsewhere
      .toSorted(byCourtThenDate(family[0]?.language ?? "en"))
      .slice(0, LIMITS.caseLawLookupCandidatesMax)
      .map(otherCourtCandidate);
  if (namesUnrecognizedCourt(constraints) && family.length > 0) {
    return {
      status: "not_found",
      reason: "court_unrecognized",
      otherCourtCandidates: toOtherCourtCandidates(family),
    };
  }
  const constrained = namesCourt(constraints);
  const atCourt = (row: DecisionIdentityRow) => atNamedCourt(constraints, row);
  const otherCourtCandidates = constrained
    ? toOtherCourtCandidates(family.filter((row) => !atCourt(row)))
    : [];
  const scopedRows = constrained ? rows.filter(atCourt) : rows;
  if (constrained && family.length > 0 && !family.some(atCourt)) {
    return {
      status: "not_found",
      reason: "not_at_this_court",
      otherCourtCandidates,
    };
  }
  const admit = async (row: DecisionIdentityRow) =>
    await admitResolvedDecision({
      constraints,
      row,
      document: async (verified) => await decisionDocument(verified, read),
      candidate,
      otherCourtCandidate,
      otherCourtCandidates,
    });
  const withOtherCourts = <
    T extends Exclude<DecisionResolveResponse, { status: "resolved" }>,
  >(
    response: T,
  ): T =>
    otherCourtCandidates.length === 0
      ? response
      : { ...response, otherCourtCandidates };
  const resolution = resolveDecisionIdentity(intent, scopedRows, {
    reporters,
  });
  switch (resolution.status) {
    case "none":
      return withOtherCourts({
        status: "not_found",
        reason: "no_exact_identity",
      });
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
          ? await admit(only)
          : withOtherCourts({
              status: "not_found",
              reason: "no_exact_identity",
            });
      }
      return withOtherCourts({
        status: "ambiguous",
        candidates: resolution.candidates
          .slice(0, LIMITS.caseLawLookupCandidatesMax)
          .map(candidate),
      });
    }
    case "unique":
      return await admit(resolution.decision);
    case "incomplete_identifier":
      // A bare docket of a file that can hold several decisions, of which the
      // lookup found exactly one: that is the decision. Asking for a sheet the
      // reader does not have only hides it; several are `ambiguous`.
      return await admit(resolution.decision);
    default:
      resolution satisfies never;
      return panic("Unhandled decision identity resolution");
  }
};

export const resolveDecision = async (
  options: ResolveDecisionOptions,
): Promise<LegalResolveResponse> => await resolveConstrainedDecision(options);
