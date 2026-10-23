import * as v from "valibot";

import { resourceIdSchema } from "@/api/lib/custom-schema";

export const numberSeriesParams = v.object({
  numberSeriesId: resourceIdSchema("numberSeries"),
});

const documentType = v.picklist(["invoice", "advance", "credit_note"]);
const name = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const pattern = v.pipe(v.string(), v.minLength(5), v.maxLength(128));
const padding = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6));

export const createNumberSeriesBody = v.object({
  documentType,
  name,
  pattern,
  padding,
  sellerProfileId: v.optional(resourceIdSchema("sellerProfile")),
});

export const updateNumberSeriesBody = v.object({
  name: v.optional(name),
  pattern: v.optional(pattern),
  padding: v.optional(padding),
  sellerProfileId: v.optional(v.nullable(resourceIdSchema("sellerProfile"))),
});
