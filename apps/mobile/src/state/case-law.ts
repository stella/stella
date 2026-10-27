import type { Result } from "better-result";
import * as v from "valibot";

import {
  createCaseLawDecisionPath,
  createCaseLawDecisionRouteParams,
} from "@stll/api-contract/case-law-decision-route";
import { PUBLIC_CASE_LAW_PAGE_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import type { PublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import type { UiLocale } from "@stll/locales";

import type { Fetch } from "@/connection/http";
import { requestPublicApi } from "@/state/api-request";
import type { ApiRequestError } from "@/state/api-request";

/** The public corpus routes the web's case-law pages read. */
const DECISIONS_PATH = "/v1/case/decisions";
const SEARCH_PATH = "/v1/case/decisions/search";

/** Rows a page asks for, as the web's case-law grid does. */
const PAGE_SIZE = 25;

/** The jurisdictions the web's case-law pages offer, in its order. */
export const CASE_LAW_COUNTRIES = PUBLIC_CASE_LAW_PAGE_COUNTRIES;

export type CaseLawCountry = PublicCaseLawCountry;

/**
 * The jurisdiction a reader starts in, by the app's language: the web's
 * `DEFAULT_COUNTRY_BY_LOCALE`, falling back to the first public one.
 */
const COUNTRY_BY_LOCALE: Partial<Record<UiLocale, string>> = {
  cs: "CZE",
  hu: "HUN",
  pl: "POL",
  sk: "SVK",
};

export const defaultCaseLawCountry = (locale: string): CaseLawCountry => {
  const wanted = Object.entries(COUNTRY_BY_LOCALE).find(
    ([language]) => language === locale,
  )?.[1];
  return (
    CASE_LAW_COUNTRIES.find((country) => country === wanted) ??
    CASE_LAW_COUNTRIES[0] ??
    "CZE"
  );
};

/** One decision in a list: what its row shows and what opens it. */
const listedDecisionFields = {
  caseNumber: v.string(),
  court: v.string(),
  decisionDate: v.nullish(v.string()),
  decisionType: v.nullish(v.string()),
  headnote: v.optional(v.unknown()),
};

const listResponseSchema = v.object({
  items: v.array(
    v.object({
      id: v.pipe(v.string(), v.minLength(1)),
      ...listedDecisionFields,
    }),
  ),
  nextCursor: v.nullish(v.string()),
});

const searchResponseSchema = v.object({
  hits: v.array(
    v.object({
      decisionId: v.pipe(v.string(), v.minLength(1)),
      ...listedDecisionFields,
    }),
  ),
  nextCursor: v.nullish(v.string()),
});

export type DecisionSummary = {
  readonly id: string;
  readonly caseNumber: string;
  readonly court: string;
  readonly decisionDate: string | null;
  readonly decisionType: string | null;
  /** The headnote's opening, or the publisher's keywords; null when it has none. */
  readonly preview: string | null;
};

export type DecisionsPage = {
  readonly decisions: readonly DecisionSummary[];
  readonly nextCursor: string | null;
};

/**
 * A page of decisions: the newest in a jurisdiction when nothing is searched
 * for, else the search's matches, as the web's case-law index lists them.
 */
export const listDecisions = async ({
  country,
  cursor,
  fetch,
  query,
  serverUrl,
}: {
  readonly country: CaseLawCountry;
  readonly cursor?: string | null | undefined;
  readonly fetch: Fetch;
  readonly query: string;
  readonly serverUrl: string;
}): Promise<Result<DecisionsPage, ApiRequestError>> => {
  const search = query.trim();
  const after = cursor === null || cursor === undefined ? {} : { cursor };
  if (search === "") {
    const params = new URLSearchParams({
      country,
      limit: String(PAGE_SIZE),
      ...after,
    });
    const listed = await requestPublicApi({
      fetch,
      path: `${DECISIONS_PATH}?${params.toString()}`,
      schema: listResponseSchema,
      serverUrl,
    });
    return listed.map(({ items, nextCursor }) => ({
      decisions: items.map((item) => summarize(item.id, item)),
      nextCursor: nextCursor ?? null,
    }));
  }
  const found = await requestPublicApi({
    body: { country, limit: PAGE_SIZE, query: search, ...after },
    fetch,
    path: SEARCH_PATH,
    schema: searchResponseSchema,
    serverUrl,
  });
  return found.map(({ hits, nextCursor }) => ({
    decisions: hits.map((hit) => summarize(hit.decisionId, hit)),
    nextCursor: nextCursor ?? null,
  }));
};

/** The next page's decisions after those already shown, each once. */
export const appendDecisionsPage = (
  loaded: readonly DecisionSummary[],
  next: readonly DecisionSummary[],
): DecisionSummary[] => {
  const seen = new Set(loaded.map((decision) => decision.id));
  return [...loaded, ...next.filter((decision) => !seen.has(decision.id))];
};

const headnoteSchema = v.variant("type", [
  v.object({ type: v.literal("present"), text: v.string() }),
  v.object({
    type: v.literal("keywords"),
    items: v.array(v.string()),
    omitted: v.optional(v.number()),
  }),
]);

/**
 * What a row or the reader shows of a headnote: the text the publisher wrote,
 * or the terms it filed the decision under. Absent, withheld or a kind this
 * build does not know, nothing.
 */
export const headnoteText = (headnote: unknown): string | null => {
  const parsed = v.safeParse(headnoteSchema, headnote);
  if (!parsed.success) {
    return null;
  }
  const value = parsed.output;
  const text =
    value.type === "present" ? value.text.trim() : value.items.join(" · ");
  return text === "" ? null : text;
};

const documentSchema = v.object({ blocks: v.array(v.unknown()) });

const decisionSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  caseNumber: v.string(),
  court: v.string(),
  country: v.string(),
  language: v.nullish(v.string()),
  languageAlternates: v.nullish(v.array(v.object({ language: v.string() }))),
  slug: v.nullish(v.string()),
  ecli: v.nullish(v.string()),
  decisionDate: v.nullish(v.string()),
  decisionType: v.nullish(v.string()),
  headnote: v.optional(v.unknown()),
  documentAst: v.nullish(documentSchema),
  fulltext: v.nullish(v.string()),
  sourceUrl: v.nullish(v.string()),
});

export type Decision = {
  readonly id: string;
  readonly caseNumber: string;
  readonly court: string;
  readonly ecli: string | null;
  readonly decisionDate: string | null;
  readonly decisionType: string | null;
  readonly headnote: string | null;
  /** The structured text's blocks, as the web's reader draws them. */
  readonly blocks: readonly unknown[] | null;
  /** The plain text, for a decision without the structured form. */
  readonly fulltext: string | null;
  readonly sourceUrl: string | null;
  /** The decision's page on the web, relative to the web app's origin. */
  readonly webPath: string;
};

/** One decision, to read in full. */
export const readDecision = async ({
  decisionId,
  fetch,
  serverUrl,
}: {
  readonly decisionId: string;
  readonly fetch: Fetch;
  readonly serverUrl: string;
}): Promise<Result<Decision, ApiRequestError>> => {
  const read = await requestPublicApi({
    fetch,
    path: `${DECISIONS_PATH}/${encodeURIComponent(decisionId)}`,
    schema: decisionSchema,
    serverUrl,
  });
  return read.map((decision) => ({
    id: decision.id,
    caseNumber: decision.caseNumber,
    court: decision.court,
    ecli: decision.ecli ?? null,
    decisionDate: decision.decisionDate ?? null,
    decisionType: decision.decisionType ?? null,
    headnote: headnoteText(decision.headnote),
    blocks: decision.documentAst?.blocks ?? null,
    fulltext: decision.fulltext ?? null,
    sourceUrl: decision.sourceUrl ?? null,
    webPath: createCaseLawDecisionPath(
      createCaseLawDecisionRouteParams({
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.id,
        language: decision.language ?? null,
        languageAlternates: decision.languageAlternates ?? null,
        slug: decision.slug ?? null,
      }),
    ),
  }));
};

function summarize(
  id: string,
  decision: {
    caseNumber: string;
    court: string;
    decisionDate?: string | null | undefined;
    decisionType?: string | null | undefined;
    headnote?: unknown;
  },
): DecisionSummary {
  return {
    id,
    caseNumber: decision.caseNumber,
    court: decision.court,
    decisionDate: decision.decisionDate ?? null,
    decisionType: decision.decisionType ?? null,
    preview: headnoteText(decision.headnote),
  };
}

/** A jurisdiction's flag and short name, for the choice over the list. */
const COUNTRY_LABELS: Readonly<Record<string, string>> = {
  CZE: "🇨🇿 CZ",
  EU: "🇪🇺 EU",
  HUN: "🇭🇺 HU",
  POL: "🇵🇱 PL",
  SVK: "🇸🇰 SK",
};

export const countryLabel = (country: CaseLawCountry): string =>
  COUNTRY_LABELS[country] ?? country;
