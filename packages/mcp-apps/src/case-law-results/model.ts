import { panic } from "better-result";

import { normalizeCountry } from "@stll/agent-input/country";
import { normalizeDateBound } from "@stll/agent-input/date-value";
import { normalizeStringList } from "@stll/agent-input/string-list";
import {
  COURT_TIER_LABELS,
  type CourtTierLabel,
} from "@stll/api-contract/case-law-court-tiers";
import { parseLegalCitationHttpUrl } from "@stll/api-contract/legal-citation-links";
import { compareCodeUnit, getCollator } from "@stll/collation";

import type {
  CourtCatalog,
  ResolveResults,
  SearchResults,
} from "../shared/generated/contracts";
import { projectAppToolArguments } from "../shared/tool-input";

type SearchPage = Extract<SearchResults, { results: unknown }>;
type RowContent =
  | {
      type: "search";
      textAvailability: SearchPage["results"][number]["textAvailability"];
      match: SearchPage["results"][number]["match"];
      snippet: string | null;
      keywords: SearchPage["results"][number]["keywords"];
      headnote:
        | NonNullable<SearchPage["results"][number]["headnote"]>
        | { type: "not_stated" }
        | { type: "omitted" };
    }
  | { type: "resolve"; snippet: null };

export type ResultRow = Pick<
  SearchPage["results"][number],
  | "decisionId"
  | "court"
  | "courtAbbreviation"
  | "decisionDate"
  | "caseNumber"
  | "ecli"
  | "url"
  | "source_url"
> &
  RowContent;

const resultRow = <Content extends RowContent>(
  row: Omit<ResultRow, keyof RowContent>,
  details: Content,
) => ({
  decisionId: row.decisionId,
  court: row.court,
  decisionDate: row.decisionDate,
  caseNumber: row.caseNumber,
  ecli: row.ecli,
  url: parseLegalCitationHttpUrl(row.url)?.href ?? null,
  source_url:
    parseLegalCitationHttpUrl(row.source_url ?? null)?.href ?? undefined,
  ...details,
  courtAbbreviation: row.courtAbbreviation,
});

const searchHeadnote = (
  row: SearchPage["results"][number],
  availability: SearchPage["headnotes"],
) => {
  switch (availability) {
    case "omitted":
      return { type: "omitted" } as const;
    case "included":
      return row.headnote === null
        ? ({ type: "not_stated" } as const)
        : {
            type: row.headnote.type,
            text: row.headnote.text,
            truncated: row.headnote.truncated,
          };
    default:
      return panic(
        "Unknown headnote availability",
        availability satisfies never,
      );
  }
};

// Only the rendered fields and the next-page handle survive in the view state.
export const searchView = (data: SearchResults) => {
  if (!("results" in data)) {
    return {
      type: "unavailable",
      message: data.message,
      hint: data.hint,
    } as const;
  }
  return {
    type: "search",
    results: data.results.map((row) =>
      resultRow(row, {
        type: "search",
        match: row.match,
        textAvailability: row.textAvailability,
        // A licence-withheld row carries no excerpt to show.
        snippet: "snippet" in row ? row.snippet : null,
        keywords:
          row.keywords === null
            ? null
            : {
                type: row.keywords.type,
                items: row.keywords.items.map((item) => item),
                omitted: row.keywords.omitted,
              },
        headnote: searchHeadnote(row, data.headnotes),
      }),
    ),
    facets:
      data.facets === null
        ? null
        : {
            court: data.facets.court.map(({ tierLabel, courts }) => ({
              tierLabel,
              courts: courts.map(({ value, count }) => ({ value, count })),
            })),
          },
    nextCursor: data.nextCursor,
    searches: data.searches.map(({ warnings }) => ({
      warnings: warnings.map(({ audience, message }) => ({
        audience,
        message,
      })),
    })),
  } as const;
};

export const resolveView = (data: ResolveResults) => {
  switch (data.status) {
    case "resolved": {
      const { document } = data;
      switch (document.kind) {
        case "decision":
          return {
            type: "resolve",
            status: data.status,
            rows: [
              resultRow(
                {
                  decisionId: document.decisionId,
                  caseNumber: document.caseNumber,
                  ecli: document.ecli,
                  court: document.court,
                  courtAbbreviation: null,
                  decisionDate: document.decisionDate,
                  url: document.readerUrl,
                },
                { type: "resolve", snippet: null },
              ),
            ],
          } as const;
        case "provision":
          return panic("Case-law resolver returned a statute provision");
        default:
          document satisfies never;
          return panic("Unknown resolved document kind");
      }
    }
    case "ambiguous":
      return {
        type: "resolve",
        status: data.status,
        candidates: data.candidates.map(
          ({ decisionId, identifier, label, readerUrl }) => ({
            type: "resolve" as const,
            decisionId,
            identifier,
            label,
            url: parseLegalCitationHttpUrl(readerUrl)?.href ?? null,
          }),
        ),
      } as const;
    case "incomplete_identifier":
      return {
        type: "resolve",
        status: data.status,
        missing: data.missing.map((part) => part),
      } as const;
    case "not_found":
      return {
        type: "resolve",
        status: data.status,
        reason: data.reason,
      } as const;
    case "country_unavailable":
      return { type: "resolve", status: data.status } as const;
    default:
      data satisfies never;
      return panic("Unknown legal resolution status");
  }
};
export type CaseLawView =
  ReturnType<typeof searchView> | ReturnType<typeof resolveView>;

type CourtFacets = NonNullable<
  Extract<CaseLawView, { type: "search" }>["facets"]
>;
type CourtPickerGroup = {
  tierLabel: CourtCatalog["courts"][number]["tierLabel"];
  courts: { value: string; count: number | null }[];
};

/**
 * Pages of one country's catalog joined into one: each tier's courts in page
 * order, tiers apex first. Pages run by court name, so an apex court can
 * arrive on a later page than a regional one; the tier order is fixed rather
 * than taken from arrival.
 */
export const appendCourtCatalogPage = (
  catalog: CourtCatalog | null,
  page: CourtCatalog,
): CourtCatalog => {
  if (catalog === null || catalog.country !== page.country) {
    return page;
  }
  const courtsOf = (tierLabel: CourtTierLabel) =>
    [catalog, page].flatMap(
      ({ courts }) =>
        courts.find((tier) => tier.tierLabel === tierLabel)?.courts ?? [],
    );
  return {
    country: page.country,
    courts: COURT_TIER_LABELS.flatMap((tierLabel) => {
      const courts = courtsOf(tierLabel);
      return courts.length === 0 ? [] : [{ tierLabel, courts }];
    }),
    nextCursor: page.nextCursor,
  };
};

/**
 * What the court picker lists. The country's catalog names every court it
 * holds, so a search with few or no results still offers them all; the
 * facets add how many of the current results each court holds, summed over
 * every spelling of the court. A court the facets do not name has no count:
 * facets list each tier's largest courts, so absence is not zero. Without a
 * catalog for the country (not read yet, or unreadable), the facets alone.
 */
export const courtPickerGroups = ({
  catalog,
  facets,
}: {
  catalog: CourtCatalog | null;
  facets: CourtFacets | null;
}): CourtPickerGroup[] => {
  const facetGroups = facets?.court ?? [];
  if (catalog === null) {
    return facetGroups.map(({ tierLabel, courts }) => ({
      tierLabel,
      courts: courts.map(({ value, count }) => ({ value, count })),
    }));
  }
  const counts = new Map(
    facetGroups.flatMap(({ courts }) =>
      courts.map(({ value, count }) => [value, count] as const),
    ),
  );
  return catalog.courts.map(({ tierLabel, courts }) => ({
    tierLabel,
    courts: courts
      .map(({ value, aliases }) => {
        const known = [value, ...aliases].flatMap((name) => {
          const count = counts.get(name);
          return count === undefined ? [] : [count];
        });
        return {
          value,
          count:
            known.length === 0 ? null : known.reduce((sum, n) => sum + n, 0),
        };
      })
      // Courts holding current results lead their tier, most first; the
      // rest keep the catalog's order.
      .toSorted((left, right) => (right.count ?? -1) - (left.count ?? -1)),
  }));
};

type CourtSelection =
  | { type: "all" }
  | { type: "court"; name: string }
  | { type: "courts"; names: readonly string[] };

type SearchFilterArgs = {
  input: Record<string, unknown>;
  country: string;
  court: CourtSelection;
  from: string;
  to: string;
};

export const searchFilterInput = ({
  input,
  country,
  court,
  from,
  to,
}: SearchFilterArgs) => {
  const declared = projectAppToolArguments("search_case_law", input);
  const {
    cursor: _cursor,
    court: _court,
    courts: _courts,
    date_from: _from,
    date_to: _to,
    country: _country,
    ...rest
  } = declared;
  const base = {
    ...rest,
    country,
    ...(from === "" ? {} : { date_from: from }),
    ...(to === "" ? {} : { date_to: to }),
  };
  switch (court.type) {
    case "all":
      return base;
    case "court":
      return { ...base, court: court.name };
    case "courts":
      return { ...base, courts: [...court.names] };
    default:
      return panic("Unknown court selection", court satisfies never);
  }
};

/** The search box text a call's own queries fill it with. */
export const originalSearchQuery = (input: Record<string, unknown>) => {
  const queries = normalizeStringList(input["queries"], { split: "never" });
  return queries.ok ? queries.value.join(" ") : "";
};

type SearchSubmitArgs = SearchFilterArgs & {
  /** The search box as the user left it. */
  query: string;
  /** The search box as the call's own queries filled it. */
  originalQuery: string;
};

/**
 * The search the form submits. An untouched box keeps the call's own queries,
 * every phrasing included; an edited box is one query, and a box left empty is
 * no query. A search needs queries or a provision, so a form with neither has
 * nothing to send.
 */
export const searchSubmitInput = ({
  query,
  originalQuery,
  ...filters
}: SearchSubmitArgs) => {
  const { queries: original, ...rest }: Record<string, unknown> =
    searchFilterInput(filters);
  const typed = query.trim();
  const queries = (() => {
    if (query === originalQuery) {
      return original;
    }
    return typed === "" ? undefined : [typed];
  })();
  const input: Record<string, unknown> =
    queries === undefined ? rest : { ...rest, queries };
  return queries === undefined && rest["provision"] === undefined
    ? ({ type: "needs_query" } as const)
    : ({ type: "search", input } as const);
};

export const filterDefaults = (input: Record<string, unknown>) => {
  const country = normalizeCountry(input["country"]);
  if (!country.ok) {
    return { status: "invalid", messageKey: "invalidCountry" } as const;
  }
  const from = normalizeDateBound(input["date_from"] ?? "", { bound: "start" });
  if (from.ok === false) {
    return { status: "invalid", messageKey: "invalidDateFrom" } as const;
  }
  const to = normalizeDateBound(input["date_to"] ?? "", { bound: "end" });
  if (to.ok === false) {
    return { status: "invalid", messageKey: "invalidDateTo" } as const;
  }
  const courts =
    input["courts"] === undefined || input["courts"] === null
      ? ({ ok: true, value: [] } as const)
      : normalizeStringList(input["courts"], { split: "never" });
  if (!courts.ok) {
    return { status: "invalid", messageKey: "invalidCourts" } as const;
  }
  return {
    status: "ready",
    country: country.value.alpha3,
    from: from.ok === true ? from.value : "",
    to: to.ok === true ? to.value : "",
    courts: courts.value,
    court: typeof input["court"] === "string" ? input["court"] : "",
  } as const;
};

export type ResultSort = "relevance" | "court" | "date";
export const sortResultRows = (
  rows: readonly ResultRow[],
  sort: ResultSort,
  locale: string,
): readonly ResultRow[] => {
  switch (sort) {
    case "relevance":
      return rows;
    case "court":
      return rows.toSorted((left, right) =>
        getCollator(locale).compare(left.court, right.court),
      );
    case "date":
      return rows.toSorted((left, right) =>
        compareCodeUnit(right.decisionDate ?? "", left.decisionDate ?? ""),
      );
    default:
      return panic("Unknown result sort", sort satisfies never);
  }
};
