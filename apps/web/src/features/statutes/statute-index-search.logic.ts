import { panic } from "better-result";
import * as v from "valibot";

import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";
import { readStatuteQueryScope } from "@stll/api-contract/statute-query-capability";
import {
  parseStatuteQuery,
  type StatuteQueryIntent,
} from "@stll/api-contract/statute-query-intent";

import {
  publicLawPageSearchSchema,
  publicLawPageSizeSearchSchema,
} from "@/components/public-law-table/public-law-pagination.logic";
import { lawYearSearchSchema } from "@/lib/legal/law-year-search";

export const STATUTE_MAX_QUERY_LENGTH = 256;

const optionalStringSchema = (maxLength: number) =>
  v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.maxLength(maxLength),
      v.transform((value) => (value.length > 0 ? value : undefined)),
    ),
  );

export const statutesIndexSearchSchema = v.object({
  page: publicLawPageSearchSchema,
  pageSize: publicLawPageSizeSearchSchema,
  q: optionalStringSchema(STATUTE_MAX_QUERY_LENGTH),
  type: optionalStringSchema(128),
  year: lawYearSearchSchema,
  // A link is public and may be edited by hand or by a crawler; a status this
  // build does not know is not an error page, it is every status.
  validity: v.fallback(
    v.optional(v.picklist(LEGISLATION_LIST_VALIDITIES)),
    undefined,
  ),
});

export type StatutesIndexSearch = v.InferOutput<
  typeof statutesIndexSearchSchema
>;

/** What an entry asks for in this jurisdiction. */
export const readStatuteIntent = (
  country: string,
  q: string | undefined,
): StatuteQueryIntent => {
  if (q === undefined) {
    return { type: "empty" };
  }
  const scope = readStatuteQueryScope(country);
  switch (scope.type) {
    case "supported":
      return parseStatuteQuery(scope.country, q);
    case "unsupported":
      // Without an act grammar the entry can still match titles, so it is
      // searched as text rather than refused.
      return { type: "text", text: q };
    default: {
      scope satisfies never;
      return panic(`Unhandled statute query scope: ${String(scope)}`);
    }
  }
};

type ChangeStatutesIndexQueryOptions = {
  country: string;
  previous: StatutesIndexSearch;
  query: string;
};

/** Full-text has no validity or publication year filter; queries invalidate list cursors. */
export const changeStatutesIndexQuery = ({
  country,
  previous,
  query,
}: ChangeStatutesIndexQueryOptions): StatutesIndexSearch => {
  const q = query.trim() || undefined;
  const intent = readStatuteIntent(country, q);
  return {
    page: undefined,
    pageSize: previous.pageSize,
    q,
    type: previous.type,
    year: intent.type === "text" ? undefined : previous.year,
    validity: intent.type === "text" ? undefined : previous.validity,
  };
};
