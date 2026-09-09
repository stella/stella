import { Type } from "@sinclair/typebox";
import { t } from "elysia";

import { SEARCH_TOTAL_TYPE } from "@stll/api-contract/search";
import type { SearchTotal } from "@stll/api-contract/search";

type CountedSearchTotalType = Extract<
  SearchTotal,
  { readonly count: number }
>["type"];

const countedSearchTotalSchema = (type: CountedSearchTotalType) =>
  t.Object(
    {
      type: t.Literal(type),
      count: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  );

const searchTotalRuntimeSchema = t.Union([
  countedSearchTotalSchema(SEARCH_TOTAL_TYPE.EXACT),
  countedSearchTotalSchema(SEARCH_TOTAL_TYPE.ESTIMATE),
  t.Object(
    { type: t.Literal(SEARCH_TOTAL_TYPE.NOT_COUNTED) },
    { additionalProperties: false },
  ),
]);

// SAFETY: the runtime branches are closed and derived from the same constants;
// Unsafe preserves their discriminated-union static type instead of TypeBox's
// intersection-like inference for object unions.
export const searchTotalSchema = Type.Unsafe<SearchTotal>(
  searchTotalRuntimeSchema,
);
