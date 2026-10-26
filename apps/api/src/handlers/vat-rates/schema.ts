import * as v from "valibot";

import { VAT_RATE_PRESET_COUNTRIES } from "@stll/api-contract";
import { apiDateSchema } from "@stll/api-contract/api-date";

import { resourceIdSchema } from "@/api/lib/custom-schema";

export const vatRateParams = v.object({
  vatRateId: resourceIdSchema("vatRate"),
});
const code = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const name = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const rateBps = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(0),
  v.maxValue(2_147_483_647),
);
const date = apiDateSchema;
export const createVatRateBody = v.object({
  code,
  name,
  rateBps,
  validFrom: date,
  validTo: v.optional(v.nullable(date)),
});
export const updateVatRateBody = v.object({
  code: v.optional(code),
  name: v.optional(name),
  rateBps: v.optional(rateBps),
  validFrom: v.optional(date),
  validTo: v.optional(v.nullable(date)),
});
export const applyVatRatePresetBody = v.object({
  country: v.picklist(VAT_RATE_PRESET_COUNTRIES),
});
