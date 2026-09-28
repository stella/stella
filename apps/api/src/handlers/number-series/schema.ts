import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";

export const numberSeriesParams = t.Object({
  numberSeriesId: tSafeId("numberSeries"),
});

const documentType = t.Union([
  t.Literal("invoice"),
  t.Literal("advance"),
  t.Literal("credit_note"),
]);
const name = t.String({ minLength: 1, maxLength: 128 });
const pattern = t.String({ minLength: 5, maxLength: 128 });
const padding = t.Integer({ minimum: 1, maximum: 6 });

export const createNumberSeriesBody = t.Object({
  documentType,
  name,
  pattern,
  padding,
  sellerProfileId: t.Optional(tSafeId("sellerProfile")),
});

export const updateNumberSeriesBody = t.Object({
  name: t.Optional(name),
  pattern: t.Optional(pattern),
  padding: t.Optional(padding),
  sellerProfileId: t.Optional(t.Nullable(tSafeId("sellerProfile"))),
});
