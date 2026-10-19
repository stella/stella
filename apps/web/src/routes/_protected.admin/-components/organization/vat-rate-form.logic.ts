import * as v from "valibot";

import { normalizeUnicode, ARABIC_DIGIT_FOLDS } from "@stll/text-normalize";
import { parsePlainDate, Temporal } from "@stll/time";

export const MAX_VAT_RATE_BPS = 2_147_483_647;

// NFKC folds full-width digits and separators; Arabic-Indic digits fold to
// ASCII. The Arabic decimal separator (U+066B) joins "." and ",".
const foldPercentText = (raw: string): string =>
  Array.from(
    normalizeUnicode(raw, "NFKC"),
    (char) => ARABIC_DIGIT_FOLDS[char] ?? char,
  ).join("");

export const parseVatRatePercent = (raw: string): number | null => {
  const parts = foldPercentText(raw)
    .trim()
    .split(/[.,٫]/u);
  const wholeText = parts.at(0);
  const fractionText = parts.at(1);
  if (
    parts.length > 2 ||
    wholeText === undefined ||
    !/^\d+$/u.test(wholeText) ||
    (fractionText !== undefined && !/^\d{1,2}$/u.test(fractionText))
  ) {
    return null;
  }
  const whole = Number(wholeText);
  const fraction = Number((fractionText ?? "").padEnd(2, "0"));
  const rateBps = whole * 100 + fraction;
  if (!Number.isSafeInteger(rateBps) || rateBps > MAX_VAT_RATE_BPS) {
    return null;
  }
  return rateBps;
};

export const vatRatePercentInput = (rateBps: number) => {
  const whole = Math.floor(rateBps / 100);
  const remainder = rateBps % 100;
  if (remainder === 0) {
    return String(whole);
  }
  const fraction =
    remainder % 10 === 0
      ? String(remainder / 10)
      : String(remainder).padStart(2, "0");
  return `${whole}.${fraction}`;
};

export const isVatPeriodValid = ({
  validFrom,
  validTo,
}: {
  validFrom: string;
  validTo: string | null;
}) => {
  const start = parsePlainDate(validFrom);
  if (start === null) {
    return false;
  }
  if (validTo === null) {
    return true;
  }
  const end = parsePlainDate(validTo);
  return end !== null && Temporal.PlainDate.compare(end, start) > 0;
};

type VatRateValidationMessages = {
  required: string;
  invalidField: string;
  invalidRate: string;
  invalidPeriod: string;
};
export const vatRateFormSchema = (messages: VatRateValidationMessages) =>
  v.pipe(
    v.object({
      code: v.pipe(
        v.string(),
        v.trim(),
        v.nonEmpty(messages.required),
        v.maxLength(64, messages.invalidField),
      ),
      name: v.pipe(
        v.string(),
        v.trim(),
        v.nonEmpty(messages.required),
        v.maxLength(128, messages.invalidField),
      ),
      ratePercent: v.pipe(
        v.string(),
        v.rawTransform(({ dataset, addIssue, NEVER }) => {
          const rateBps = parseVatRatePercent(dataset.value);
          if (rateBps === null) {
            addIssue({ message: messages.invalidRate });
            return NEVER;
          }
          return rateBps;
        }),
      ),
      validFrom: v.pipe(
        v.string(),
        v.check(
          (date) => parsePlainDate(date) !== null,
          messages.invalidPeriod,
        ),
      ),
      validTo: v.pipe(
        v.string(),
        v.transform((date) => (date === "" ? null : date)),
      ),
    }),
    v.forward(
      v.partialCheck(
        [["validFrom"], ["validTo"]],
        ({ validFrom, validTo }) => isVatPeriodValid({ validFrom, validTo }),
        messages.invalidPeriod,
      ),
      ["validTo"],
    ),
    v.transform(({ ratePercent, ...value }) => ({
      ...value,
      rateBps: ratePercent,
    })),
  );
