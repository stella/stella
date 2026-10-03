import * as v from "valibot";

import { LEGISLATION_LIST_VALIDITIES } from "@stll/api-contract/legislation-status";
import {
  parseStatuteQuery,
  type StatuteQueryIntent,
} from "@stll/api-contract/statute-query-intent";

import {
  publicLawPageSearchSchema,
  publicLawPageSizeSearchSchema,
} from "@/components/public-law-table/public-law-pagination.logic";
import { isStatuteCountry } from "@/lib/statute-route";

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

/**
 * What an entry asks for in this jurisdiction. A country the grammar does
 * not know reads every entry as text.
 */
export const readStatuteIntent = (
  country: string,
  q: string | undefined,
): StatuteQueryIntent => {
  if (q === undefined) {
    return { type: "empty" };
  }
  return isStatuteCountry(country)
    ? parseStatuteQuery(country, q)
    : { type: "text", text: q };
};

type ChangeStatutesIndexQueryOptions = {
  country: string;
  previous: StatutesIndexSearch;
  query: string;
};

/** Full-text has no validity filter; a query change also invalidates list cursors. */
export const changeStatutesIndexQuery = ({
  country,
  previous,
  query,
}: ChangeStatutesIndexQueryOptions): StatutesIndexSearch => {
  const q = query.trim() || undefined;
  return {
    page: undefined,
    pageSize: previous.pageSize,
    q,
    type: previous.type,
    validity:
      readStatuteIntent(country, q).type === "text"
        ? undefined
        : previous.validity,
  };
};
