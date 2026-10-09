import { panic } from "better-result";

import {
  normalizeCountry,
  normalizeDateBound,
  normalizeStringList,
} from "@stll/agent-input";
import { parseLegalCitationHttpUrl } from "@stll/api-contract/legal-citation-links";
import { compareCodeUnit, getCollator } from "@stll/collation";

import type { LookupResults, SearchResults } from "../shared/contracts";

type SearchPage = Extract<SearchResults, { results: unknown }>;
type LookupPage = Extract<LookupResults, { items: unknown }>;
type RowContent =
  | {
      type: "search";
      snippet: string | null;
      keywords: SearchPage["results"][number]["keywords"];
      headnote:
        | NonNullable<SearchPage["results"][number]["headnote"]>
        | { type: "not_stated" }
        | { type: "omitted" };
    }
  | { type: "lookup"; snippet: null };

export type ResultRow = Pick<
  SearchPage["results"][number],
  | "decisionId"
  | "court"
  | "courtAbbreviation"
  | "decisionDate"
  | "caseNumber"
  | "ecli"
  | "appUrl"
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
  appUrl: parseLegalCitationHttpUrl(row.appUrl)?.href ?? null,
  source_url:
    parseLegalCitationHttpUrl(row.source_url ?? null)?.href ?? undefined,
  ...details,
  courtAbbreviation: row.courtAbbreviation,
});

const lookupRows = (items: LookupPage["items"]) => {
  const rows: Extract<ResultRow, { type: "lookup" }>[] = [];
  const notices: string[] = [];
  for (const item of items) {
    switch (item.status) {
      case "found":
        rows.push(
          resultRow(item, {
            type: "lookup",
            snippet: null,
          }),
        );
        break;
      case "ambiguous":
        rows.push(
          ...item.candidates.map((row) =>
            resultRow(row, {
              type: "lookup",
              snippet: null,
            }),
          ),
        );
        notices.push(item.message);
        break;
      case "not_found":
        notices.push(`${item.message} ${item.hint}`);
        break;
      case "lookup_failed":
        notices.push(item.message);
        break;
      default:
        panic("Unknown lookup status", item satisfies never);
    }
  }
  return { rows, notices };
};

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
        snippet: row.snippet,
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
              courts: courts.map(({ value }) => ({ value })),
            })),
          },
    nextCursor: data.nextCursor,
    searches: data.searches.map(({ warnings }) => ({
      warnings: warnings.map(({ message, hint }) => ({ message, hint })),
    })),
    nextStep: data.nextStep,
  } as const;
};

export const lookupView = (data: LookupResults) => {
  if (!("items" in data)) {
    return {
      type: "unavailable",
      message: data.message,
      hint: data.hint,
    } as const;
  }
  return { type: "lookup", ...lookupRows(data.items) } as const;
};
export type CaseLawView =
  | ReturnType<typeof searchView>
  | ReturnType<typeof lookupView>;

export type CourtSelection =
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
  const {
    cursor: _cursor,
    court: _court,
    courts: _courts,
    date_from: _from,
    date_to: _to,
    country: _country,
    ...rest
  } = input;
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

export const filterDefaults = (input: Record<string, unknown>) => {
  const country = normalizeCountry(input["country"]);
  if (!country.ok) {
    return { status: "invalid", message: country.hint } as const;
  }
  const from = normalizeDateBound(input["date_from"] ?? "", { bound: "start" });
  if (from.ok === false) {
    return { status: "invalid", message: from.hint } as const;
  }
  const to = normalizeDateBound(input["date_to"] ?? "", { bound: "end" });
  if (to.ok === false) {
    return { status: "invalid", message: to.hint } as const;
  }
  const courts =
    input["courts"] === undefined || input["courts"] === null
      ? ({ ok: true, value: [] } as const)
      : normalizeStringList(input["courts"], { split: "never" });
  if (!courts.ok) {
    return { status: "invalid", message: courts.hint } as const;
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
