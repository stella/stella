import * as v from "valibot";

import { SEARCH_TOTAL_TYPE } from "@stll/api-contract/search";
import type { SearchTotal } from "@stll/api-contract/search";

type CountedSearchTotalType = Extract<
  SearchTotal,
  { readonly count: number }
>["type"];

const countedSearchTotalSchema = <TotalType extends CountedSearchTotalType>(
  type: TotalType,
) =>
  v.pipe(
    v.object({
      type: v.literal(type),
      count: v.pipe(
        v.number(),
        v.minValue(0),
        v.maxValue(Number.MAX_SAFE_INTEGER),
        v.multipleOf(1),
      ),
    }),
    v.readonly(),
  );

type SearchTotalSchemaByType = {
  readonly [Type in SearchTotal["type"]]: v.GenericSchema<
    unknown,
    Extract<SearchTotal, { readonly type: Type }>
  >;
};

const SEARCH_TOTAL_SCHEMAS = {
  [SEARCH_TOTAL_TYPE.EXACT]: countedSearchTotalSchema(SEARCH_TOTAL_TYPE.EXACT),
  [SEARCH_TOTAL_TYPE.ESTIMATE]: countedSearchTotalSchema(
    SEARCH_TOTAL_TYPE.ESTIMATE,
  ),
  [SEARCH_TOTAL_TYPE.NOT_COUNTED]: v.pipe(
    v.object({ type: v.literal(SEARCH_TOTAL_TYPE.NOT_COUNTED) }),
    v.readonly(),
  ),
} as const satisfies SearchTotalSchemaByType;

// The branches are closed and exhaustively keyed by the shared discriminator,
// so the union's output is `SearchTotal` itself.
export const searchTotalSchema = v.union([
  SEARCH_TOTAL_SCHEMAS.exact,
  SEARCH_TOTAL_SCHEMAS.estimate,
  SEARCH_TOTAL_SCHEMAS.not_counted,
]);
