/* eslint-disable require-invoice-link-delivery-gate/require-invoice-link-delivery-gate */
import { Result as R } from "better-result";
import { createSafeTokenHandler } from "@/api/lib/api-handlers";

export const directSuccess = createSafeTokenHandler(() => R.ok(response));
export const missingDelivery = createSafeTokenHandler(() => R.err(error));
