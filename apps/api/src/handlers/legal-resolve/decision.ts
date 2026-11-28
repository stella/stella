import { panic } from "better-result";

import { normalizeCountry } from "@stll/agent-input";
import {
  exactDecisionMatches,
  resolveDecisionIdentity,
} from "@stll/api-contract/decision-query-intent";
import { decisionReporterGrammarForJurisdiction } from "@stll/api-contract/decision-reporter-grammar";
import type { LegalResolveResponse } from "@stll/api-contract/legal-resolve";
import {
  isPublicCountry,
  PUBLIC_COUNTRY_CAPABILITIES,
  PUBLIC_COUNTRY_SURFACE_OPEN,
} from "@stll/api-contract/public-country-capability";
import { decisionDocketGrammarForCountry } from "@stll/case-law-ingestion-core/adapter-manifest";
import { compareByLocale, compareCodeUnit } from "@stll/collation";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import type { DecisionIdentityRow } from "@/api/handlers/case-law/decisions/lookup-by-identity";
import {
  decisionIdentityLocatorOf,
  lookupDecisionsByIdentity,
} from "@/api/handlers/case-law/decisions/lookup-by-identity";
import { readDecisionReaderSource } from "@/api/handlers/case-law/decisions/reader";
import type { LawReadAdmission } from "@/api/handlers/legal-resolve/admission";
import {
  type AbsenceCoverageSnapshot,
  decisionAbsenceCoverage,
  decisionAbsenceHint,
} from "@/api/handlers/legal-resolve/decision-absence-coverage";
import {
  admitResolvedDecision,
  atNamedCourt,
  type DecisionConstraints,
  decisionConstraints,
  decisionResolveIntent,
  type DecisionResolveResponse,
  namesCourt,
  namesUnrecognizedCourt,
  readDecisionCitation,
} from "@/api/handlers/legal-resolve/decision-constraints";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { parseCachedDecisionAst } from "@/api/lib/case-law/decision-ast-normalization";
import {
  readDecisionReviews,
  requireDecisionReviews,
} from "@/api/lib/case-law/decision-reviews";
import { CASE_LAW_SURFACE_COUNTRIES } from "@/api/lib/case-law/public-subject";
import { buildCaseLawDecisionUrl } from "@/api/lib/legal-search/public-law-app-urls";
import { LIMITS } from "@/api/lib/limits";
import { toPlainCorpusText } from "@/api/mcp/tool-utils";

type DecisionResolverDependencies = {
  lookup?: typeof lookupDecisionsByIdentity;
  read?: typeof readDecisionReaderSource;
  readReviews?: typeof readDecisionReviews;
  readCoverage?: () => Promise<AbsenceCoverageSnapshot | null>;
};

/**
 * The stored coverage answer, or null when it could not be read. Imported on
 * use, as the coverage tool does, so resolve loads it only for an absence.
 */
const readStoredCoverage =
  async (): Promise<AbsenceCoverageSnapshot | null> => {
    const { readCaseLawCoverageHandler } =
      await import("@/api/handlers/case-law/decisions/coverage");
    const answer = await readCaseLawCoverageHandler(caseLawPublicReadDb);
    return "message" in answer ? null : answer;
  };

/** The directory courts a citation's words name, for narrowing its sources. */
const namedCourtsOf = (constraints: DecisionConstraints): string[] =>
  constraints.courts.flatMap((constraint) => {
    switch (constraint.type) {
      case "court":
        return [...constraint.courts];
      case "ecli-code":
        return constraint.court === undefined ? [] : [constraint.court];
      case "unrecognized":
        return [];
      default: {
        constraint satisfies never;
        return panic(`Unhandled court constraint: ${String(constraint)}`);
      }
    }
  });

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
    const plainText = toPlainCorpusText({
      blocks: document.blocks,
      fulltext: null,
    });
    if (plainText === null) {
      return { status: "unavailable" };
    }
    return { status: "readable", charCount: plainText.length };
  }
  return { status: "withheld", reason: "licence" };
};

/**
 * Publisher identity evidence distinguishes siblings of a docket even when
 * the court, kind and date coincide. Reporter references remain typed: a
 * cited docket or a parallel case number is not a publication label.
 */
const candidateLabel = (row: DecisionIdentityRow): string =>
  [
    row.court,
    row.decisionType,
    row.senate,
    row.decisionDate ?? row.caseNumber,
    row.publishedCaseNumber,
    ...new Set(
      row.identifiers
        .filter(
          ({ type }) => type === DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        )
        .map(({ value }) => value)
        .toSorted(compareCodeUnit),
    ),
  ]
    .filter((part) => typeof part === "string" && part !== "")
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
type DecisionDocumentOptions = {
  row: DecisionIdentityRow;
  read: typeof readDecisionReaderSource;
  readReviews: typeof readDecisionReviews;
};

const decisionDocument = async ({
  row,
  read,
  readReviews,
}: DecisionDocumentOptions): Promise<ResolvedDecisionDocument> => {
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
    appealReviews:
      content?.status === "read" && content.decision.id === row.id
        ? content.decision.appealReviews
        : requireDecisionReviews(
            await readReviews({
              decisionIds: [row.id],
              caseLawDb: caseLawPublicReadDb,
            }),
            row.id,
          ),
  };
};

const ambiguousDecisionCandidates = (
  rows: readonly DecisionIdentityRow[],
  completeness: "complete" | "truncated",
) =>
  ({
    status: "ambiguous",
    ...(completeness === "truncated" ||
    rows.length > LIMITS.caseLawLookupCandidatesMax
      ? { candidateSet: "truncated" as const }
      : {}),
    candidates: rows.slice(0, LIMITS.caseLawLookupCandidatesMax).map(candidate),
  }) as const satisfies DecisionResolveResponse;

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
    readReviews = readDecisionReviews,
    readCoverage = readStoredCoverage,
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
  const { intent, courtText } = readDecisionCitation({
    country,
    identifier,
    intent: decisionResolveIntent(identifier, { grammar, reporters }),
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
  if (rows.some((row) => row.exactIdentityRead === "truncated")) {
    return ambiguousDecisionCandidates(
      family.filter(
        (row) => !namesCourt(constraints) || atNamedCourt(constraints, row),
      ),
      "truncated",
    );
  }
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
      document: async (verified) =>
        await decisionDocument({ row: verified, read, readReviews }),
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
    exactIdentityRead: rows.at(0)?.exactIdentityRead,
  });
  const answer = async (): Promise<DecisionResolveResponse> => {
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
        return withOtherCourts(
          ambiguousDecisionCandidates(resolution.candidates, "complete"),
        );
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
  // Every absence says what the reconciled listings know about it, so a
  // reader can tell "not published" from "not ingested" without the publisher.
  const withAbsenceCoverage = async (
    response: DecisionResolveResponse,
  ): Promise<DecisionResolveResponse> => {
    if (
      response.status !== "not_found" ||
      response.reason !== "no_exact_identity"
    ) {
      return response;
    }
    const snapshot = await readCoverage();
    if (snapshot === null) {
      return { ...response, coverage: { status: "unavailable" } };
    }
    const coverage = decisionAbsenceCoverage({
      snapshot,
      country,
      intent,
      grammar,
      namedCourts: namedCourtsOf(constraints),
    });
    const hint = decisionAbsenceHint(coverage);
    return {
      ...response,
      coverage,
      ...(hint === undefined ? {} : { hint }),
    };
  };
  return await withAbsenceCoverage(await answer());
};

export const resolveDecision = async (
  options: ResolveDecisionOptions,
): Promise<LegalResolveResponse> => await resolveConstrainedDecision(options);
