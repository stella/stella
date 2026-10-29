import { panic } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import {
  ECLI_COURT_REGISTRY,
  type RegisteredCourt,
} from "@stll/api-contract/case-law-courts";
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
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { parseCachedDecisionAst } from "@/api/lib/case-law/decision-ast-normalization";
import { CASE_LAW_SURFACE_COUNTRIES } from "@/api/lib/case-law/public-subject";
import { servedBlockText } from "@/api/lib/case-law/served-paragraph-number";
import { decisionDocketGrammarForCountry } from "@/api/lib/legal-search/adapter-manifest";
import { buildCaseLawDecisionUrl } from "@/api/lib/legal-search/public-law-app-urls";
import { LIMITS } from "@/api/lib/limits";
import {
  mentionsCourt,
  readCourtFilter,
  storedCourtIdentities,
} from "@/api/mcp/case-law-court-filter";
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
type NamedCourt =
  | { type: "none" }
  | { type: "court"; courts: readonly [string, ...string[]] }
  | { type: "unrecognized" };

/**
 * The court a citation names around its docket. A court the vocabulary
 * cannot read still constrains the citation: no holder of the docket is
 * known to be that court, so none may be resolved in its place. Words that
 * name no court at all leave the docket unconstrained.
 */
const readNamedCourt = (
  embeddedIn: string | undefined,
  identities: Parameters<typeof readCourtFilter>[0]["identities"],
): NamedCourt => {
  if (embeddedIn === undefined) {
    return { type: "none" };
  }
  const reading = readCourtFilter({ court: embeddedIn, identities });
  if (reading.type === "court") {
    return { type: "court", courts: reading.courts };
  }
  return mentionsCourt(embeddedIn)
    ? { type: "unrecognized" }
    : { type: "none" };
};

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
  textState: row.textState,
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

const resolvedDecision = async (
  row: DecisionIdentityRow,
  read: typeof readDecisionReaderSource,
): Promise<Extract<LegalResolveResponse, { status: "resolved" }>> => {
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
      textState: row.textState,
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
  // Read the court against the full registry, not just this docket's holders:
  // a court with no hit must still constrain the citation.
  const registry = Object.entries(ECLI_COURT_REGISTRY).find(
    ([jurisdiction]) => jurisdiction === normalized.value.alpha2,
  )?.[1];
  const identities = storedCourtIdentities(country, [
    ...new Set([
      ...Object.values<RegisteredCourt>(registry ?? {}).map(({ name }) => name),
      ...rows.map(({ court }) => court),
    ]),
  ]);
  const namedCourt = readNamedCourt(
    intent.kind === "docket" ? intent.embeddedIn : undefined,
    identities,
  );
  const namedCourts =
    namedCourt.type === "court" ? namedCourt.courts : undefined;
  const unrecognizedCourt = namedCourt.type === "unrecognized";
  // A sheet lookup intentionally does not load every member of a file.
  // Discover other courts through the indexed bare-family lookup while
  // retaining the exact read for selecting the requested decision.
  const docketRows =
    (namedCourts !== undefined || unrecognizedCourt) &&
    intent.kind === "docket" &&
    intent.selector.kind !== "none"
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
  const family = exactDecisionMatches(
    intent,
    [...new Map([...rows, ...docketRows].map((row) => [row.id, row])).values()],
    { reporters },
  );
  const toOtherCourtCandidates = (holders: readonly DecisionIdentityRow[]) =>
    holders
      .toSorted(byCourtThenDate(family[0]?.language ?? "en"))
      .slice(0, LIMITS.caseLawLookupCandidatesMax)
      .map((row) => ({
        ...candidate(row),
        court: row.court,
        decisionDate: row.decisionDate,
        decisionType: row.decisionType,
        subjectSummary: row.subjectSummary ?? null,
      }));
  if (unrecognizedCourt && family.length > 0) {
    return {
      status: "not_found",
      reason: "court_unrecognized",
      otherCourtCandidates: toOtherCourtCandidates(family),
    };
  }
  const otherCourtCandidates =
    namedCourts === undefined
      ? []
      : toOtherCourtCandidates(
          family.filter(({ court }) => !namedCourts.includes(court)),
        );
  const scopedRows =
    namedCourts === undefined
      ? rows
      : rows.filter(({ court }) => namedCourts.includes(court));
  if (
    namedCourts !== undefined &&
    family.length > 0 &&
    !family.some(({ court }) => namedCourts.includes(court))
  ) {
    return {
      status: "not_found",
      reason: "not_at_this_court",
      otherCourtCandidates,
    };
  }
  type LookupResolutionResponse = Exclude<
    LegalResolveResponse,
    { status: "country_unavailable" }
  >;
  const resolve = async (): Promise<LookupResolutionResponse> => {
    const resolution = resolveDecisionIdentity(intent, scopedRows, {
      reporters,
    });
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
            ? await resolvedDecision(only, read)
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
        return await resolvedDecision(resolution.decision, read);
      case "incomplete_identifier": {
        // A bare docket of a file that can hold several decisions. When the
        // lookup finds exactly one, that is the decision: asking for a sheet
        // the reader does not have only hides it. Several stay unresolved, and
        // exact identity never picks one of them for the caller.
        const [only, ...rest] = resolution.candidates;
        if (only !== undefined && rest.length === 0) {
          return await resolvedDecision(only, read);
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
  const result = await resolve();
  return otherCourtCandidates.length === 0
    ? result
    : { ...result, otherCourtCandidates };
};
