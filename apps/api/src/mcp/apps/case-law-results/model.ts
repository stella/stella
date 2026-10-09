import { panic } from "better-result";

import {
  normalizeCountry,
  normalizeDateBound,
  normalizeStringList,
} from "@stll/agent-input";
import { parseLegalCitationHttpUrl } from "@stll/api-contract/legal-citation-links";
import { compareCodeUnit, getCollator } from "@stll/collation";

import type { ResolveResults, SearchResults } from "../shared/contracts";

type SearchPage = Extract<SearchResults, { results: unknown }>;
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
  | { type: "resolve"; snippet: null };

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
                  appUrl: document.readerUrl,
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
            decisionId,
            identifier,
            label,
            appUrl: parseLegalCitationHttpUrl(readerUrl)?.href ?? null,
          }),
        ),
      } as const;
    case "incomplete_identifier":
      return {
        type: "resolve",
        status: data.status,
        missing: data.missing,
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
  | ReturnType<typeof searchView>
  | ReturnType<typeof resolveView>;

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
