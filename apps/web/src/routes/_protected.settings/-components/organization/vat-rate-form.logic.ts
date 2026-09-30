import * as v from "valibot";

import { parsePlainDate, Temporal } from "@stll/time";

export const MAX_VAT_RATE_BPS = 2_147_483_647;

export const parseVatRatePercent = (raw: string): number | null => {
  const match = /^(\d+)(?:[.,](\d{1,2}))?$/u.exec(raw.trim());
  if (match === null) {
    return null;
  }
  const whole = Number(match.at(1));
  const fraction = Number((match.at(2) ?? "").padEnd(2, "0"));
  const rateBps = whole * 100 + fraction;
  if (!Number.isSafeInteger(rateBps) || rateBps > MAX_VAT_RATE_BPS) {
    return null;
  }
  return rateBps;
};

export const vatRatePercentInput = (rateBps: number) => {
  const fraction = String(rateBps % 100)
    .padStart(2, "0")
    .replace(/0+$/u, "");
  return `${Math.floor(rateBps / 100)}${fraction === "" ? "" : `.${fraction}`}`;
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
    v.forward(v.check(isVatPeriodValid, messages.invalidPeriod), ["validTo"]),
    v.transform(({ ratePercent, ...value }) => ({
      ...value,
      rateBps: ratePercent,
    })),
  );
