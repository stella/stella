import { useTranslations } from "use-intl";

import { CURRENCY_CODE_LENGTH } from "@stll/api-contract";
import { tryToMinorUnits } from "@stll/money";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";

import { majorUnitInput } from "@/components/billing/amount-input.logic";
import { formatCurrencyAmount } from "@/components/billing/format-currency";

type TimeEntryRateFieldsProps = {
  currency: string;
  rate: number;
  override: boolean;
  draft: string;
  onOverride: () => void;
  onDraftChange: (draft: string) => void;
  onCurrencyChange: (currency: string) => void;
};

export const TimeEntryRateFields = ({
  currency,
  rate,
  override,
  draft,
  onOverride,
  onDraftChange,
  onCurrencyChange,
}: TimeEntryRateFieldsProps) => {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label>{t("billing.rates.hourlyRate")}</Label>
        {!override && rate > 0 && (
          <button
            className="text-muted-foreground text-xs underline"
            onClick={onOverride}
            type="button"
          >
            {t("billing.rates.override")}
          </button>
        )}
      </div>
      {override ? (
        <div className="flex gap-2">
          <Input
            className="flex-1"
            dir="ltr"
            inputMode="decimal"
            onBlur={() => {
              const amount = tryToMinorUnits({ amount: draft, currency });
              if (amount !== null) {
                onDraftChange(majorUnitInput(amount, currency));
              }
            }}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            placeholder="350.00"
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
