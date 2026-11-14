import { panic } from "better-result";
import * as v from "valibot";

import { lawYearSearchSchema } from "@stll/api-contract/law-year";
import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";
import {
  STATUTE_LIST_SORTS,
  statuteListSortIsBounded,
} from "@stll/api-contract/statute-list-sort";
import { readStatuteQueryScope } from "@stll/api-contract/statute-query-capability";
import {
  parseStatuteQuery,
  type StatuteQueryIntent,
} from "@stll/api-contract/statute-query-intent";
import { parsePlainDate } from "@stll/time";

import {
  publicLawPageSearchSchema,
  publicLawPageSizeSearchSchema,
} from "@/components/public-law-table/public-law-pagination.logic";
import { routeSearchSchema } from "@/route-search-params";

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

export const statutesIndexSearchSchema = routeSearchSchema({
  page: publicLawPageSearchSchema,
  pageSize: publicLawPageSizeSearchSchema,
  q: optionalStringSchema(STATUTE_MAX_QUERY_LENGTH),
  asOf: v.optional(
    v.pipe(
      v.string(),
      v.trim(),
      v.isoDate(),
      v.check((value) => parsePlainDate(value) !== null),
    ),
  ),
  type: optionalStringSchema(128),
  year: lawYearSearchSchema,
  // A link is public and may be edited by hand or by a crawler; a status this
  // build does not know is not an error page, it is every status.
  validity: v.fallback(
    v.optional(v.picklist(LEGISLATION_LIST_VALIDITIES)),
    undefined,
  ),
  // A column order; read only alongside a year (`statuteListSortIsBounded`).
  // An order this build does not know reads as the default order. Named
  // apart from the case-law list's `sort`, whose values differ: a navigation
  // between the two lists carries the other list's search along.
  order: v.fallback(v.optional(v.picklist(STATUTE_LIST_SORTS)), undefined),
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

/**
 * Full-text has no validity or publication year filter; queries invalidate
 * list cursors. A column order lasts only while a year bounds the list, so
 * every change that drops the year drops the order with it.
 */
export const changeStatutesIndexQuery = ({
  country,
  previous,
  query,
}: ChangeStatutesIndexQueryOptions): StatutesIndexSearch => {
  const q = query.trim() || undefined;
  const intent = readStatuteIntent(country, q);
  const year = intent.type === "text" ? undefined : previous.year;
  return {
    page: undefined,
    pageSize: previous.pageSize,
    ...(previous.asOf === undefined ? {} : { asOf: previous.asOf }),
    q,
    type: previous.type,
    year,
    validity: intent.type === "text" ? undefined : previous.validity,
    order: statuteListSortIsBounded({ year }) ? previous.order : undefined,
  };
};
