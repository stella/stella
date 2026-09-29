import { Result } from "better-result";

import { cents, type CentsAmount } from "@stll/money";

import { invalidInput, type InvoicingResult } from "./errors";
import type { VatTreatment } from "./types";

export const VAT_TREATMENTS = [
  "domestic_vat",
  "not_vat_payer",
  "reverse_charge",
  "exempt",
] as const satisfies readonly VatTreatment[];

true satisfies Exclude<
  VatTreatment,
  (typeof VAT_TREATMENTS)[number]
> extends never
  ? true
  : never;

const QUANTITY_PATTERN = /^(?<whole>0|[1-9]\d*)(?:\.(?<fraction>\d+))?$/u;
const MAX_MINOR_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER);

type CalculateLineNetAmountInput = {
  /** A non-negative decimal written with a dot, e.g. "1.5" or "0.1667". */
  quantity: string;
  unitPriceMinor: CentsAmount;
};

/**
 * Net amount of one line: quantity times unit price, rounded half up to a
 * whole minor unit. The product is exact (bigint), so neither a long decimal
 * quantity nor a large unit price loses precision before the one rounding.
 */
export const calculateLineNetAmount = ({
  quantity,
  unitPriceMinor,
}: CalculateLineNetAmountInput): InvoicingResult<CentsAmount> => {
  const match = QUANTITY_PATTERN.exec(quantity);
  const whole = match?.groups?.["whole"];
  if (whole === undefined) {
    return invalidInput("Quantity must be a non-negative decimal number");
  }
  if (!Number.isSafeInteger(unitPriceMinor) || unitPriceMinor < 0) {
    return invalidInput("Unit price must be a non-negative minor amount");
  }

  const fraction = match?.groups?.["fraction"] ?? "";
  const scale = 10n ** BigInt(fraction.length);
  const product = BigInt(`${whole}${fraction}`) * BigInt(unitPriceMinor);
  const rounded = (product * 2n + scale) / (scale * 2n);
  if (rounded > MAX_MINOR_AMOUNT) {
    return invalidInput("Line amount exceeds the largest supported amount");
  }
  return Result.ok(cents(Number(rounded)));
};
