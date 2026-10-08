/**
 * The pieces of `read_case_law_decision`'s answer that are pure functions of
 * a read: page arithmetic, the text version, the compact metadata block, the
 * citation summary and the paragraphs a `query` selects.
 *
 * Kept apart from the handler so each rule is tested on its own, and so the
 * one projection MCP and chat share is built from the same functions.
 */

import { panic } from "better-result";

import type { DecisionTextWithheldReason } from "@stll/api-contract/case-law-text-field";

import type { DecisionCitationDigest } from "@/api/handlers/case-law/decisions/citation-digest";
import type { RankedRelatedDecision } from "@/api/handlers/case-law/decisions/citation-graph";
import { CITATION_TREATMENTS } from "@/api/lib/case-law/citation-vocabulary";
import type { CitationTreatment } from "@/api/lib/case-law/citation-vocabulary";
import { corpusTokens } from "@/api/lib/legal-search/corpus-tokens";
import { documentMorphologyLanguage } from "@/api/lib/legal-search/morphology/corpus-language";
import { stemLegalTerm } from "@/api/lib/legal-search/morphology/stem";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";
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
  new Bun.CryptoHasher("sha256")
    .update(text)
    .digest("base64url")
    .slice(0, TEXT_VERSION_CHARS);

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
 * A value two keys may share only by restating each other: text, a list or a
 * record. A flag or a count is left alone, because two different facts can
 * both be `true` or `3`.
 */
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
 * publisher filed it under; and a value two keys both carry (a publisher's
 * native label beside the canonical one, `kategorieRozhodnuti` beside
 * `category`), of which the shorter key is kept, the canonical names being
 * the short English ones. Everything else passes through as stored.
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
  // The first key per shared value, shortest name first.
  const keeper = new Map<string, string>();
  for (const [key, value] of kept.toSorted(
    ([left], [right]) => left.length - right.length || compareKeys(left, right),
  )) {
    const duplicate = duplicateKeyOf(value);
    if (duplicate !== null && !keeper.has(duplicate)) {
      keeper.set(duplicate, key);
    }
  }
  return Object.fromEntries(
    kept.filter(([key, value]) => {
      const duplicate = duplicateKeyOf(value);
      return duplicate === null || keeper.get(duplicate) === key;
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
  const top = rankCitingDecisions(digest.topCiting).map((decision) => {
    const appUrl = appUrlOf(decision);
    return {
      caseNumber: decision.caseNumber,
      court: decision.court,
      decisionId: String(decision.id),
      ...(decision.decisionDate === null
        ? {}
        : { date: decision.decisionDate }),
      ...(appUrl === null ? {} : { url: appUrl }),
    };
  });

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
      const appUrl = appUrlOf(row.decision);
      cited.set(key, {
        caseNumber: row.decision.caseNumber,
        decisionId: String(row.decision.id),
        ...(appUrl === null ? {} : { url: appUrl }),
      });
    }
  }

  return {
    citedBy: {
      count: citedByCount,
      ...(digest.summary.capped.incoming ? { capped: true as const } : {}),
      ...(citedByCount === 0
        ? {}
        : { polarity: occurringTreatments(digest.summary.incoming) }),
      ...(top.length === 0 ? {} : { top }),
    },
    cites: {
      count: totalOf(digest.summary.outgoing),
      ...(digest.summary.capped.outgoing ? { capped: true as const } : {}),
      ...(cited.size === 0 ? {} : { decisions: [...cited.values()] }),
      ...(digest.citesMore ? { more: true as const } : {}),
    },
  };
};

// --- paragraphs matching a query ---------------------------------------------

/** One paragraph of the served text, numbered from 1 in document order. */
export type DecisionParagraph = {
  anchorId: string | null;
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
    ? located.map((block) => ({ anchorId: block.anchorId, text: block.text }))
    : text.split(/\r?\n/u).flatMap((line) => {
        const trimmed = line.trim();
        return trimmed === "" ? [] : [{ anchorId: null, text: trimmed }];
      });

/** Matched paragraphs one call returns; `hitCount` says how many there were. */
export const QUERY_HIT_LIMIT = 20;

const fold = (term: string): string =>
  term.normalize("NFD").replaceAll(/\p{M}/gu, "").toLowerCase();

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

export type QueryParagraph = DecisionParagraph & {
  /** 1-based position among the decision's paragraphs. */
  paragraph: number;
  /** True on a matching paragraph; a neighbour shown for context has none. */
  hit: boolean;
};

/**
 * The paragraphs holding every word of `query`, each with the paragraph
 * before and after it, in document order and without repeats. At most
 * `QUERY_HIT_LIMIT` matches, and no more text than `budget` characters: the
 * first match is cut to it, and a neighbour or later match that does not fit
 * what is left is dropped and marks the answer truncated.
 */
export const paragraphsMatching = ({
  budget,
  language,
  paragraphs,
  query,
}: {
  budget: number;
  language: string;
  paragraphs: readonly DecisionParagraph[];
  query: string;
}): { hitCount: number; paragraphs: QueryParagraph[]; truncated: boolean } => {
  const termOf = termMatcher(language);
  const wanted = [...new Set(corpusTokens(query).map(termOf))];
  if (wanted.length === 0) {
    return panic("A paragraph query must carry a word");
  }
  const hits = paragraphs.flatMap((paragraph, index) => {
    const terms = new Set(corpusTokens(paragraph.text).map(termOf));
    return wanted.every((term) => terms.has(term)) ? [index] : [];
  });

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
      if (neighbour >= 0 && neighbour < paragraphs.length) {
        take(neighbour);
      }
    }
  }
  const hitSet = new Set(hits);
  return {
    hitCount: hits.length,
    paragraphs: [...chosen]
      .toSorted(([left], [right]) => left - right)
      .map(([index, length]) => {
        const paragraph =
          paragraphs[index] ?? panic("A chosen paragraph must exist");
        return {
          anchorId: paragraph.anchorId,
          text: paragraph.text.slice(0, length),
          paragraph: index + 1,
          hit: hitSet.has(index),
        };
      }),
    truncated,
  };
};
