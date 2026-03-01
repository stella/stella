import { t } from "elysia";

export const dateRangeQuerySchema = t.Object({
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
});

export const GRANULARITY_VALUES = ["day", "week", "month"] as const;

export const periodQuerySchema = t.Object({
  dateFrom: t.Optional(t.String({ format: "date" })),
  dateTo: t.Optional(t.String({ format: "date" })),
  granularity: t.Optional(t.UnionEnum(GRANULARITY_VALUES)),
});

export type DateRangeQuery = {
  dateFrom?: string;
  dateTo?: string;
};

export type PeriodQuery = DateRangeQuery & {
  granularity?: (typeof GRANULARITY_VALUES)[number];
};
