import { panic, Result } from "better-result";
import * as v from "valibot";
/**
 * The pieces of `read_case_law_decision`'s answer that are pure functions of
 * a read: page arithmetic, the text version, the compact metadata block, the
 * citation summary and the paragraphs a `query` selects.
 *
 * Kept apart from the handler so each rule is tested on its own, and so the
 * one projection MCP and chat share is built from the same functions.
 */

import type { DecisionTextWithheldReason } from "@stll/api-contract/case-law-text-field";
import { createSha256 } from "@stll/sha256/bun";
import { stripUnicodeMarks } from "@stll/text-normalize";

import type { DecisionCitationDigest } from "@/api/handlers/case-law/decisions/citation-digest";
import type { RankedRelatedDecision } from "@/api/handlers/case-law/decisions/citation-graph";
import { CITATION_TREATMENTS } from "@/api/lib/case-law/citation-vocabulary";
import type { CitationTreatment } from "@/api/lib/case-law/citation-vocabulary";
import { normalizePublicDecisionLanguage } from "@/api/lib/case-law/decision-language";
import {
  queryWordsAbsentWarning,
  queryWordsApartWarning,
} from "@/api/lib/case-law/search-warnings";
import type { DecisionQueryWarning } from "@/api/lib/case-law/search-warnings";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import { documentMorphologyLanguage } from "@/api/lib/legal-search/morphology/corpus-language";
import { stemLegalTerm } from "@/api/lib/legal-search/morphology/stem";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";
import { printedParagraphLabel } from "@/api/mcp/case-law-decision-outline";
import type { LocatedDecisionBlock } from "@/api/mcp/case-law-decision-outline";
import { resolveTextWindowBounds } from "@/api/mcp/tool-utils";

// --- text pages ------------------------------------------------------------

/**
 * Where every page of `text` starts at a window of `size` characters. Pages
 * are the windows a reader walking the text from the start would get, so they
 * never overlap and never split a code point; page N starts at `starts[N-1]`.
 */
export const textPageStarts = (text: string, size: number): number[] => {
  const starts = [0];
  let bounds = resolveTextWindowBounds({ text, offset: 0, size });
  while (bounds.nextOffset !== null) {
    starts.push(bounds.nextOffset);
    bounds = resolveTextWindowBounds({ text, offset: bounds.nextOffset, size });
  }
  return starts;
};

/** The 1-based page holding `offset`: the last page starting at or before it. */
export const pageOfOffset = (
  starts: readonly number[],
  offset: number,
): number => {
  let page = 1;
  for (const [index, start] of starts.entries()) {
    if (start > offset) {
      break;
    }
    page = index + 1;
  }
  return page;
};

/** One page's span, or null for a page past the last one. */
export const textPageSpan = ({
  page,
  starts,
  text,
}: {
  page: number;
  starts: readonly number[];
  text: string;
}): { start: number; end: number } | null => {
  const start = starts[page - 1];
  if (start === undefined) {
    return null;
  }
  return { start, end: starts[page] ?? text.length };
};

/** Characters of the text version token; enough to tell versions apart. */
const TEXT_VERSION_CHARS = 12;

/**
 * A short token naming this exact text. A caller paging a decision passes it
 * back; a different token means the publisher's text changed between calls,
 * so page numbers it holds may now address other passages.
 */
export const decisionTextVersion = (text: string): string =>
  createSha256().update(text).digest("base64url").slice(0, TEXT_VERSION_CHARS);

/**
 * Split one fixed text budget without stranding the shares of short texts.
 * The first pass is even; the second gives the remainder to truncated texts
 * in input order. This order is part of the batch-read contract.
 */
export const decisionTextAllowances = (
  lengths: readonly number[],
  cap: number,
): number[] => {
  if (lengths.length === 0) {
    return [];
  }
  const share = Math.floor(cap / lengths.length);
  const allowances = lengths.map((length) => Math.min(length, share));
  let remaining = cap - allowances.reduce((sum, value) => sum + value, 0);
  // Unused shares only complete documents, in input order. A document that
  // stays truncated keeps exactly the even share, so its later pages use the
  // same window whatever its siblings' lengths are on that request.
  for (const [index, length] of lengths.entries()) {
    const allowance = allowances[index] ?? 0;
    const needed = length - allowance;
    if (needed > 0 && needed <= remaining) {
      allowances[index] = length;
      remaining -= needed;
    }
  }
  return allowances;
};

/**
 * Ordinal order for keys, ISO dates and ids: none of them is language, so no
 * locale may reorder them.
 */
const compareKeys = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

// --- metadata --------------------------------------------------------------

const comparableScalar = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

const isEmptyValue = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0);

/**
 * Publisher-native keys that record the same field as a canonical key, keyed
 * by the native name. Equal values under two other keys are two facts (a
 * presiding judge who is also the rapporteur), so only a declared pair is
 * ever collapsed.
 */
const NATIVE_METADATA_ALIASES: Readonly<Record<string, string>> = {
  kategorieRozhodnuti: "category",
};

/** Text, a list or a record, compared as stored; null for anything else. */
const duplicateKeyOf = (value: unknown): string | null => {
  if (typeof value === "string") {
    return comparableScalar(value);
  }
  if (Array.isArray(value) || isRecord(value)) {
    return JSON.stringify(value);
  }
  return null;
};

/**
 * Publisher metadata without what the answer already says.
 *
 * Dropped: empty values; a value that restates a top-level field of the
 * answer (the court, the date, the docket, the ECLI, a URL), whatever key the
 * publisher filed it under; and a publisher's native label that restates its
 * canonical key (`kategorieRozhodnuti` beside an equal `category`). Everything
 * else passes through as stored, including different keys that happen to hold
 * the same value.
 */
export const compactDecisionMetadata = ({
  metadata,
  restated,
}: {
  metadata: Readonly<Record<string, unknown>>;
  restated: readonly unknown[];
}): Record<string, unknown> => {
  const answered = new Set(
    restated.flatMap((value) => {
      const comparable = comparableScalar(value);
      return comparable === null ? [] : [comparable];
    }),
  );
  const kept = Object.entries(metadata).filter(([, value]) => {
    if (isEmptyValue(value)) {
      return false;
    }
    const comparable = comparableScalar(value);
    return comparable === null || !answered.has(comparable);
  });
  return Object.fromEntries(
    kept.filter(([key, value]) => {
      const canonical = Object.hasOwn(NATIVE_METADATA_ALIASES, key)
        ? NATIVE_METADATA_ALIASES[key]
        : undefined;
      if (canonical === undefined || !Object.hasOwn(metadata, canonical)) {
        return true;
      }
      const duplicate = duplicateKeyOf(value);
      return (
        duplicate === null || duplicate !== duplicateKeyOf(metadata[canonical])
      );
    }),
  );
};

// --- citations ---------------------------------------------------------------

/** Citing decisions the summary names; the rest are one tool call away. */
export const TOP_CITING_DECISIONS = LIMITS.caseLawTopCitingDecisions;

type AppUrlOf = (decision: RankedRelatedDecision) => string | null;

const totalOf = (counts: Readonly<Record<CitationTreatment, number>>) =>
  CITATION_TREATMENTS.reduce((sum, treatment) => sum + counts[treatment], 0);

/** Only the treatments that occur, in the vocabulary's order. */
const occurringTreatments = (
  counts: Readonly<Record<CitationTreatment, number>>,
): Partial<Record<CitationTreatment, number>> =>
  Object.fromEntries(
    CITATION_TREATMENTS.flatMap((treatment) =>
      counts[treatment] > 0 ? [[treatment, counts[treatment]] as const] : [],
    ),
  );

/**
 * Most authoritative first, then the most recent, then by id so equal rows
 * keep one order. The query ranks the same way; ranking again here keeps the
 * order a property of this function rather than of a seam.
 */
export const rankCitingDecisions = (
  decisions: readonly RankedRelatedDecision[],
): RankedRelatedDecision[] => {
  const distinct = new Map(
    decisions.map((decision) => [String(decision.id), decision] as const),
  );
  return [...distinct.values()]
    .toSorted(
      (left, right) =>
        right.citationAuthority - left.citationAuthority ||
        compareKeys(right.decisionDate ?? "", left.decisionDate ?? "") ||
        compareKeys(String(left.id), String(right.id)),
    )
    .slice(0, TOP_CITING_DECISIONS);
};

export const citationSummaryOutput = (
  digest: DecisionCitationDigest,
  appUrlOf: AppUrlOf,
) => {
  const citedByCount = totalOf(digest.summary.incoming);
  const top = rankCitingDecisions(digest.topCiting.items).map((decision) => {
    const url = appUrlOf(decision);
    return {
      caseNumber: decision.caseNumber,
      court: decision.court,
      decisionId: String(decision.id),
      ...(decision.decisionDate === null
        ? {}
        : { date: decision.decisionDate }),
      ...(url === null ? {} : { url }),
    };
  });

  const topResult = (() => {
    const result = digest.topCiting;
    switch (result.precision) {
      case "exact":
        return { precision: "exact" as const, items: top };
      case "bounded":
        return {
          precision: "bounded" as const,
          candidateWindow: result.candidateWindow,
          items: top,
        };
      default: {
        result satisfies never;
        return panic("Unknown top-citer precision");
      }
    }
  })();

  // One entry per cited decision, or per citation text where the corpus does
  // not hold the decision it names.
  const cited = new Map<
    string,
    | { caseNumber: string; decisionId: string; url?: string }
    | { citation: string; textWithheldReason: null }
    | { citation: null; textWithheldReason: DecisionTextWithheldReason }
  >();
  for (const row of digest.cites) {
    if (row.decision === null) {
      if (row.textWithheldReason !== null) {
        const key = `withheld:${row.textWithheldReason}`;
        if (!cited.has(key)) {
          cited.set(key, {
            citation: null,
            textWithheldReason: row.textWithheldReason,
          });
        }
        continue;
      }
      const citationText = row.citationText;
      if (citationText === null) {
        return panic("Available citation text must be present");
      }
      const key = `text:${citationText.trim().toLowerCase()}`;
      if (!cited.has(key)) {
        cited.set(key, {
          citation: citationText.trim(),
          textWithheldReason: null,
        });
      }
      continue;
    }
    const key = `decision:${String(row.decision.id)}`;
    if (!cited.has(key)) {
      const url = appUrlOf(row.decision);
      cited.set(key, {
        caseNumber: row.decision.caseNumber,
        decisionId: String(row.decision.id),
        ...(url === null ? {} : { url }),
      });
    }
  }

  return {
    citedBy: {
      doctrineCounts:
        digest.doctrineSummary.status === "unavailable"
          ? { status: "unavailable" as const }
          : {
              status: "available" as const,
              counts: digest.doctrineSummary.counts.incoming,
              capped: digest.doctrineSummary.capped.incoming,
              candidateWindow: digest.doctrineSummary.candidateWindow,
            },
      count: citedByCount,
      ...(digest.summary.precision.status === "bounded" &&
      digest.summary.precision.capped.incoming
        ? { capped: true as const }
        : {}),
      ...(citedByCount === 0
        ? {}
        : { polarity: occurringTreatments(digest.summary.incoming) }),
      top: topResult,
    },
    cites: {
      doctrineCounts:
        digest.doctrineSummary.status === "unavailable"
          ? { status: "unavailable" as const }
          : {
              status: "available" as const,
              counts: digest.doctrineSummary.counts.outgoing,
              capped: digest.doctrineSummary.capped.outgoing,
              candidateWindow: digest.doctrineSummary.candidateWindow,
            },
      count: totalOf(digest.summary.outgoing),
      ...(digest.summary.precision.status === "bounded" &&
      digest.summary.precision.capped.outgoing
        ? { capped: true as const }
        : {}),
      ...(cited.size === 0 ? {} : { decisions: [...cited.values()] }),
      ...(digest.citesMore ? { more: true as const } : {}),
    },
  };
};

// --- paragraphs matching a query ---------------------------------------------

/** One paragraph of the served text, numbered from 1 in document order. */
export type DecisionParagraph = {
  anchorId: string | null;
  number?: number | undefined;
  headingPath: string[];
  label: string | null;
  text: string;
};

/**
 * The served text as paragraphs: its located blocks when the decision has a
 * parsed document, else its non-empty lines, which carry no fragment.
 */
export const decisionParagraphs = ({
  located,
  text,
}: {
  located: readonly LocatedDecisionBlock[] | null;
  text: string;
}): DecisionParagraph[] =>
  located !== null && located.length > 0
    ? located.map(
        ({ anchorId, headingPath, label, number, text: blockText }) => ({
          anchorId,
          headingPath,
          label,
          text: blockText,
          ...(number === undefined ? {} : { number }),
        }),
      )
    : text.split(/\r?\n/u).flatMap((line) => {
        const trimmed = line.trim();
        return trimmed === ""
          ? []
          : [
              {
                anchorId: null,
                headingPath: [],
                label: printedParagraphLabel(trimmed),
                text: trimmed,
              },
            ];
      });

/** Matched paragraphs one call returns; `hitCount` says how many there were. */
export const QUERY_HIT_LIMIT = 20;

export const DECISION_QUERY_SECTIONS = ["court_reasoning"] as const;
export type DecisionQuerySection = (typeof DECISION_QUERY_SECTIONS)[number];

/**
 * Headings that open a court's own assessment, folded, by language.
 *
 * Wording, because no source marks the assessment structurally: the AST's
 * `argumentation` role covers a whole reasons section, recitals of the
 * parties' submissions included. A decision without such a heading (most
 * Czech Supreme Court decisions print one undivided "Odůvodnění") has no
 * boundary to find, and the answer says so rather than guessing one.
 */
const COURT_ASSESSMENT_HEADINGS = new Map<string, readonly RegExp[]>([
  [
    "cs",
    [
      /\bposouzeni\b/u,
      /\bvlastni hodnoceni\b/u,
      /\bduvodnost\b/u,
      /\bk predbeznym otazkam\b/u,
      /\bk prejudicialnim otazkam\b/u,
    ],
  ],
  ["sk", [/\bposudenie\b/u, /\bk prejudicialnym otazkam\b/u]],
  [
    "en",
    [
      /\bconsideration of the questions?\b/u,
      /\bfindings of the court\b/u,
      /\bthe court.s (?:assessment|findings)\b/u,
    ],
  ],
]);

/** A heading naming a court below reports that court's reasoning, not this one's. */
const LOWER_COURT_HEADING_WORDS = [
  "krajsk",
  "okresn",
  "obvodn",
  "mestsk",
  "prvniho stupne",
  "prveho stupna",
  "odvolac",
];

type CourtReasoningBoundary =
  | { type: "found"; index: number; heading: string }
  | {
      type: "not_found";
      reason: "no_assessment_heading" | "language_unsupported";
    };

const courtReasoningBoundary = ({
  language,
  paragraphs,
}: {
  language: string;
  paragraphs: readonly DecisionParagraph[];
}): CourtReasoningBoundary => {
  const primary = normalizePublicDecisionLanguage(language)?.split("-").at(0);
  const headings =
    primary === undefined ? undefined : COURT_ASSESSMENT_HEADINGS.get(primary);
  if (headings === undefined) {
    return { type: "not_found", reason: "language_unsupported" };
  }
  for (const [index, { headingPath }] of paragraphs.entries()) {
    const heading = headingPath.find((title) => {
      const folded = fold(title);
      return (
        !LOWER_COURT_HEADING_WORDS.some((word) => folded.includes(word)) &&
        headings.some((pattern) => pattern.test(folded))
      );
    });
    if (heading !== undefined) {
      return { type: "found", index, heading };
    }
  }
  return { type: "not_found", reason: "no_assessment_heading" };
};

/** What restricting a query to a section did. */
export type DecisionQuerySectionReport =
  | {
      status: "found";
      /** The heading the restriction starts under, verbatim. */
      heading: string;
      /** 1-based position of the first paragraph under it. */
      position: number;
      /** Matches before the boundary, which this answer leaves out. */
      hitsBefore: number;
    }
  | {
      status: "not_found";
      reason: "no_assessment_heading" | "language_unsupported";
    };

const QUERY_CURSOR_BINDING_CHARS = 12;

const queryCursorSchema = v.tuple([
  v.pipe(v.number(), v.integer()),
  v.string(),
  v.string(),
]);

const queryCursorBinding = ({
  decisionId,
  query,
  section,
}: DecisionQueryCursorScope): string =>
  createSha256()
    .update(JSON.stringify([decisionId, query, section ?? null]))
    .digest("base64url")
    .slice(0, QUERY_CURSOR_BINDING_CHARS);

type DecisionQueryCursorScope = {
  decisionId: string;
  query: string;
  section: DecisionQuerySection | undefined;
};

/** Continues after paragraph `after`, for the same decision, query and section only. */
export const encodeDecisionQueryCursor = ({
  after,
  decisionId,
  query,
  section,
  textVersion,
}: DecisionQueryCursorScope & {
  after: number;
  textVersion: string;
}): string =>
  Buffer.from(
    JSON.stringify([
      after,
      textVersion,
      queryCursorBinding({ decisionId, query, section }),
    ]),
  ).toString("base64url");

export const decodeDecisionQueryCursor = ({
  cursor,
  decisionId,
  query,
  section,
}: DecisionQueryCursorScope & { cursor: string }): {
  after: number;
  textVersion: string;
} | null => {
  const raw = Result.try((): unknown =>
    JSON.parse(Buffer.from(cursor, "base64url").toString()),
  );
  if (Result.isError(raw)) {
    return null;
  }
  const parsed = v.safeParse(queryCursorSchema, raw.value);
  if (!parsed.success) {
    return null;
  }
  const [after, textVersion, binding] = parsed.output;
  return binding === queryCursorBinding({ decisionId, query, section })
    ? { after, textVersion }
    : null;
};

const fold = (term: string): string =>
  stripUnicodeMarks(term, {
    form: "NFD",
    markClass: "combining",
  }).toLowerCase();

/**
 * How a word is compared: by the stem search indexes it under, in the
 * decision's own language, then folded, so "nájemného" finds "nájemné".
 * A language without a stemmer compares folded surface words.
 */
const termMatcher = (language: string) => {
  const morphology = documentMorphologyLanguage(language);
  return (token: string): string =>
    fold(morphology === null ? token : stemLegalTerm(token, morphology));
};

/**
 * Whether a paragraph holds every word of `query`, each compared as
 * `paragraphsMatching` compares them, in the paragraph's own language. Null
 * when `query` carries no word.
 */
export const paragraphWordsMatcher = (
  query: string,
): ((paragraph: string, language: string) => boolean) | null => {
  const words = corpusTokens(query);
  if (words.length === 0) {
    return null;
  }
  return (paragraph, language) => {
    const termOf = termMatcher(language);
    const terms = new Set(corpusTokens(paragraph).map(termOf));
    return words.every((word) => terms.has(termOf(word)));
  };
};

export type QueryParagraph = DecisionParagraph & {
  /** 1-based position among the decision's paragraphs. */
  position: number;
  /** True on a matching paragraph; a neighbour shown for context has none. */
  hit: boolean;
};

/**
 * Why no paragraph held every word, and the largest set one paragraph does
 * hold, in the query's own order and spelling. Asking for that set always
 * finds its paragraph, so the call the warning names cannot come back empty.
 */
const queryMissWarning = ({
  language,
  spellings,
  termSets,
}: {
  language: string;
  /** Each wanted term with the word the query spelled it as. */
  spellings: ReadonlyMap<string, string>;
  termSets: readonly ReadonlySet<string>[];
}): DecisionQueryWarning => {
  const wanted = [...spellings.keys()];
  const spellingOf = (term: string): string =>
    spellings.get(term) ?? panic("A wanted term must have its spelling");
  let largest: string[] = [];
  for (const terms of termSets) {
    const held = wanted.filter((term) => terms.has(term));
    if (held.length > largest.length) {
      largest = held;
    }
  }
  if (largest.length === 0) {
    return queryWordsAbsentWarning({ language, words: wanted.map(spellingOf) });
  }
  const present = wanted.filter((term) =>
    termSets.some((terms) => terms.has(term)),
  );
  return queryWordsApartWarning({
    absentWords: wanted
      .filter((term) => !present.includes(term))
      .map(spellingOf),
    presentWords: present.map(spellingOf),
    retry: {
      query: largest.map(spellingOf).join(" "),
      hitCount: termSets.filter((terms) =>
        largest.every((term) => terms.has(term)),
      ).length,
    },
  });
};

/**
 * The paragraphs holding every word of `query`, each with the paragraph
 * before and after it, in document order and without repeats. At most
 * `QUERY_HIT_LIMIT` matches, and no more text than `budget` characters: the
 * first match is cut to it, and a neighbour or later match that does not fit
 * what is left is dropped and marks the answer truncated. No match returns no
 * paragraph at all, with a warning naming the words.
 */
export const paragraphsMatching = ({
  after = 0,
  budget,
  language,
  paragraphs,
  query,
  section,
}: {
  /** Resume past this 1-based position; a cursor's half of the query. */
  after?: number;
  budget: number;
  language: string;
  paragraphs: readonly DecisionParagraph[];
  query: string;
  section?: DecisionQuerySection | undefined;
}): {
  hitCount: number;
  /** Position to resume after, while matches remain past this answer. */
  nextAfter: number | null;
  paragraphs: QueryParagraph[];
  section: DecisionQuerySectionReport | null;
  truncated: boolean;
  warning: DecisionQueryWarning | null;
} => {
  const termOf = termMatcher(language);
  const spellings = new Map<string, string>();
  for (const word of corpusTokens(query)) {
    const term = termOf(word);
    if (!spellings.has(term)) {
      spellings.set(term, word);
    }
  }
  const wanted = [...spellings.keys()];
  if (wanted.length === 0) {
    return panic("A paragraph query must carry a word");
  }
  const termSets = paragraphs.map(
    (paragraph) => new Set(corpusTokens(paragraph.text).map(termOf)),
  );
  const allHits = termSets.flatMap((terms, index) =>
    wanted.every((term) => terms.has(term)) ? [index] : [],
  );
  const boundary =
    section === undefined
      ? null
      : courtReasoningBoundary({ language, paragraphs });
  const floor = boundary?.type === "found" ? boundary.index : 0;
  const scopedHits = allHits.filter((index) => index >= floor);
  let sectionReport: DecisionQuerySectionReport | null = null;
  if (boundary?.type === "found") {
    sectionReport = {
      status: "found",
      heading: boundary.heading,
      position: boundary.index + 1,
      hitsBefore: allHits.length - scopedHits.length,
    };
  } else if (boundary !== null) {
    sectionReport = { status: "not_found", reason: boundary.reason };
  }
  if (scopedHits.length === 0) {
    return {
      hitCount: 0,
      nextAfter: null,
      paragraphs: [],
      section: sectionReport,
      truncated: false,
      // Matches before the boundary are not a miss: `section` counts them.
      warning:
        allHits.length > 0
          ? null
          : queryMissWarning({ language, spellings, termSets }),
    };
  }
  const hits = scopedHits.filter((index) => index + 1 > after);

  // Each chosen paragraph and how much of it travels. Only the first match
  // may be cut, to the budget, on a whole code point; everything after it
  // travels whole or not at all, so the matches never outgrow the window
  // they replace.
  const chosen = new Map<number, number>();
  let remaining = budget;
  let truncated = hits.length > QUERY_HIT_LIMIT;
  const take = (index: number): boolean => {
    if (chosen.has(index)) {
      return true;
    }
    const text = paragraphs[index]?.text ?? panic("A paragraph must exist");
    const length =
      chosen.size === 0
        ? resolveTextWindowBounds({ text, offset: 0, size: budget }).end
        : text.length;
    // The first match always travels: a one-character budget still takes a
    // whole supplementary character, as a page does.
    if (chosen.size > 0 && length > remaining) {
      truncated = true;
      return false;
    }
    chosen.set(index, length);
    remaining = Math.max(0, remaining - length);
    return true;
  };
  for (const hit of hits.slice(0, QUERY_HIT_LIMIT)) {
    if (!take(hit)) {
      break;
    }
    for (const neighbour of [hit - 1, hit + 1]) {
      if (
        neighbour >= Math.max(floor, after) &&
        neighbour < paragraphs.length
      ) {
        take(neighbour);
      }
    }
  }
  const hitSet = new Set(scopedHits);
  const lastReturned = hits.findLast((index) => chosen.has(index));
  return {
    hitCount: scopedHits.length,
    nextAfter:
      lastReturned !== undefined && hits.some((index) => index > lastReturned)
        ? lastReturned + 1
        : null,
    section: sectionReport,
    paragraphs: [...chosen]
      .toSorted(([left], [right]) => left - right)
      .map(([index, length]) => {
        const paragraph =
          paragraphs[index] ?? panic("A chosen paragraph must exist");
        return {
          anchorId: paragraph.anchorId,
          text: paragraph.text.slice(0, length),
          ...(paragraph.number === undefined
            ? {}
            : { number: paragraph.number }),
          position: index + 1,
          label: paragraph.label,
          headingPath: paragraph.headingPath,
          hit: hitSet.has(index),
        };
      }),
    truncated,
    warning: null,
  };
};
