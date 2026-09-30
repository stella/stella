import { t } from "elysia";

import { tSafeId } from "@/api/lib/custom-schema";

export const vatRateParams = t.Object({ vatRateId: tSafeId("vatRate") });
const code = t.String({ minLength: 1, maxLength: 64 });
const name = t.String({ minLength: 1, maxLength: 128 });
const rateBps = t.Integer({ minimum: 0, maximum: 2_147_483_647 });
const date = t.String({ format: "date" });
export const createVatRateBody = t.Object({
  code,
  name,
  rateBps,
  validFrom: date,
  validTo: t.Optional(t.Nullable(date)),
});
export const updateVatRateBody = t.Object({
  code: t.Optional(code),
  name: t.Optional(name),
  rateBps: t.Optional(rateBps),
  validFrom: t.Optional(date),
  validTo: t.Optional(t.Nullable(date)),
});
