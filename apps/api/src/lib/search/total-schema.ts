import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import { t } from "elysia";

import { SEARCH_TOTAL_TYPE } from "@stll/api-contract/search";
import type { SearchTotal } from "@stll/api-contract/search";

type CountedSearchTotalType = Extract<
  SearchTotal,
  { readonly count: number }
>["type"];

const countedSearchTotalSchema = <TotalType extends CountedSearchTotalType>(
  type: TotalType,
) =>
  t.Object(
    {
      type: t.Literal(type),
      count: t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    },
    { additionalProperties: false },
  );

type SearchTotalSchemaByType = {
  readonly [Type in SearchTotal["type"]]: TSchema & {
    static: Extract<SearchTotal, { readonly type: Type }>;
  };
};

const SEARCH_TOTAL_SCHEMAS = {
  [SEARCH_TOTAL_TYPE.EXACT]: countedSearchTotalSchema(SEARCH_TOTAL_TYPE.EXACT),
  [SEARCH_TOTAL_TYPE.ESTIMATE]: countedSearchTotalSchema(
    SEARCH_TOTAL_TYPE.ESTIMATE,
  ),
  [SEARCH_TOTAL_TYPE.NOT_COUNTED]: t.Object(
    { type: t.Literal(SEARCH_TOTAL_TYPE.NOT_COUNTED) },
    { additionalProperties: false },
  ),
} as const satisfies SearchTotalSchemaByType;

const searchTotalRuntimeSchema = t.Union([
  SEARCH_TOTAL_SCHEMAS.exact,
  SEARCH_TOTAL_SCHEMAS.estimate,
  SEARCH_TOTAL_SCHEMAS.not_counted,
]);

// SAFETY: the runtime branches are closed and exhaustively keyed by the shared
// discriminator; Unsafe preserves their union instead of TypeBox's
// intersection-like inference for object unions.
export const searchTotalSchema = Type.Unsafe<SearchTotal>(
  searchTotalRuntimeSchema,
);
