import { t } from "elysia";

import {
  tCurrencyCode,
  tPaginationCursor,
  tPaginationLimit,
  tSafeId,
} from "@/api/lib/custom-schema";

export const WIP_LIMITS = {
  pageDefault: 25,
  pageMax: 50,
  currenciesMax: 256,
} as const;
export const wipQuerySchema = t.Object({
  matterId: t.Optional(tSafeId("workspace")),
  clientId: t.Optional(tSafeId("contact")),
  currency: t.Optional(tCurrencyCode),
  asOf: t.Optional(
    t.String({
      format: "date",
      description:
        "UTC calendar day for aging; reuse the response asOf on subsequent pages.",
    }),
  ),
  limit: t.Optional(tPaginationLimit(WIP_LIMITS.pageMax)),
  cursor: t.Optional(tPaginationCursor()),
});
