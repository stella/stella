import { useTranslations } from "use-intl";

import { CURRENCY_CODE_LENGTH } from "@stll/api-contract/currency-code";
import {
  formatLocaleMinorUnitsInput,
  type LocaleInputText,
  localeInputText,
  parseLocaleMinorUnits,
} from "@stll/money";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";

import { majorUnitInput } from "@/components/billing/amount-input.logic";
import { formatCurrencyAmount } from "@/components/billing/format-currency";
import { useFormattingLocale } from "@/i18n/formatting-context";

type TimeEntryRateFieldsProps = {
  currency: string;
  rate: number;
  override: boolean;
  draft: LocaleInputText;
  /** The manual rate cannot be read in the selected currency. */
  invalid: boolean;
  onOverride: () => void;
  onDraftChange: (draft: LocaleInputText) => void;
  onCurrencyChange: (currency: string) => void;
};

export const TimeEntryRateFields = ({
  currency,
  rate,
  override,
  draft,
  invalid,
  onOverride,
  onDraftChange,
  onCurrencyChange,
}: TimeEntryRateFieldsProps) => {
  const t = useTranslations();
  const locale = useFormattingLocale();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label>{t("billing.rates.hourlyRate")}</Label>
        {!override && (
          <Button onClick={onOverride} size="inline" variant="muted">
            <span className="text-xs underline">
              {t("billing.rates.override")}
            </span>
          </Button>
        )}
      </div>
      {override ? (
        <div className="flex flex-col gap-1">
          <div className="flex gap-2">
            <Input
              aria-invalid={invalid}
              className="flex-1"
              dir="ltr"
              inputMode="decimal"
              onBlur={() => {
                // Display only: tidy the draft to the places the currency
                // counts. The draft stays in major units, and the scaling
                // that reaches the API waits for submit.
                const amount = parseLocaleMinorUnits({
                  amount: draft,
                  currency,
                  locale,
                });
                if (amount.isErr()) {
                  return;
                }
                onDraftChange(majorUnitInput(amount.value, currency, locale));
              }}
              onChange={(event) =>
                onDraftChange(localeInputText(event.currentTarget))
              }
              placeholder={formatLocaleMinorUnitsInput({
                amountCents: 35_000,
                currency,
                locale,
              })}
              value={draft}
            />
            <Input
              className="w-20"
              dir="ltr"
              maxLength={CURRENCY_CODE_LENGTH}
              onChange={(event) =>
                onCurrencyChange(event.currentTarget.value.toUpperCase())
              }
              value={currency}
            />
          </div>
          {invalid && (
            <p className="text-destructive text-xs" role="alert">
              {t("billing.invalidNumberFormat")}
            </p>
          )}
        </div>
      ) : (
        <div className="text-muted-foreground text-sm">
          {rate > 0
            ? `${formatCurrencyAmount(rate, currency)}${t("billing.rates.perHour")}`
            : t("billing.rates.noRateFound")}
        </div>
      )}
    </div>
  );
};
