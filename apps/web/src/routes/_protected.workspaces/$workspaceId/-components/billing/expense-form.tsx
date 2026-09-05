import { useState } from "react";

import { useForm } from "@tanstack/react-form";
import { useSelector } from "@tanstack/react-store";
import { useTranslations } from "use-intl";

import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@stll/api-contract";
import {
  currencyMinorUnitDigits,
  toMajorUnits,
  toMinorUnits,
} from "@stll/money";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { detached } from "@/lib/detached";
import { DEFAULT_CURRENCY } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";
import { MatterCombobox } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-combobox";

/**
 * The stored amount as the decimal string the amount input edits, at the
 * number of places the currency counts: a yen amount shows none, a dinar
 * amount three.
 */
const majorUnitInput = (amountCents: number, currency: string): string =>
  toMajorUnits({ amountCents, currency }).toFixed(
    currencyMinorUnitDigits(currency),
  );

export type ExpenseFormValues = {
  matterId: string;
  dateIncurred: string;
  amount: number;
  currency: string;
  category: ExpenseCategory;
  description: string;
  billable: boolean;
  markup: number;
};

type ExpenseFormProps = {
  workspaceId: string;
  defaultValues?: Partial<ExpenseFormValues>;
  onSubmit: (values: ExpenseFormValues) => void | Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
};

export const ExpenseForm = ({
  workspaceId,
  defaultValues,
  onSubmit,
  onCancel,
  submitLabel,
}: ExpenseFormProps) => {
  const t = useTranslations();
  const initialCurrency = defaultValues?.currency ?? DEFAULT_CURRENCY;
  const [amountInputValue, setAmountInputValue] = useState(() =>
    (defaultValues?.amount ?? 0) > 0
      ? majorUnitInput(defaultValues?.amount ?? 0, initialCurrency)
      : "",
  );

  const today = (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  })();

  const form = useForm({
    defaultValues: {
      matterId: defaultValues?.matterId ?? "",
      dateIncurred: defaultValues?.dateIncurred ?? today,
      currency: initialCurrency,
      category: defaultValues?.category ?? "other",
      description: defaultValues?.description ?? "",
      billable: defaultValues?.billable ?? true,
      markup: defaultValues?.markup ?? 0,
    },
    onSubmit: async ({ value }) => {
      if (!value.matterId) {
        stellaToast.add({
          title: t("billing.matterRequired"),
          type: "error",
        });
        return;
      }
      // The currency input sits beside the amount and can still change after
      // it is typed, so the minor-unit scaling happens here, against the
      // currency the form actually submits.
      const typed = Number.parseFloat(amountInputValue);
      const amount = Number.isNaN(typed)
        ? 0
        : toMinorUnits({ amount: typed, currency: value.currency });
      if (amount <= 0) {
        stellaToast.add({
          title: t("billing.failedToSave"),
          type: "error",
        });
        return;
      }
      await onSubmit({ ...value, amount });
    },
  });

  const currentCurrency = useSelector(form.store, (s) => s.values.currency);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        detached(form.handleSubmit(), "expense-form.submit");
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label>{t("common.matter")}</Label>
        <form.Field name="matterId">
          {(field) => (
            <MatterCombobox
              onChange={field.handleChange}
              value={field.state.value}
              workspaceId={workspaceId}
            />
          )}
        </form.Field>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("billing.expenses.dateIncurred")}</Label>
          <form.Field name="dateIncurred">
            {(field) => (
              <DatePickerPopover
                onChange={(v) => field.handleChange(v ?? "")}
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>

        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("common.category")}</Label>
          <form.Field name="category">
            {(field) => (
              <Select
                onValueChange={(v) => {
                  if (v) {
                    field.handleChange(v);
                  }
                }}
                value={field.state.value}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {EXPENSE_CATEGORIES.map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {t(`billing.expenses.categories.${cat}`)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </form.Field>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("billing.amount")}</Label>
          <Input
            dir="ltr"
            inputMode="decimal"
            onBlur={() => {
              const typed = Number.parseFloat(amountInputValue);
              if (Number.isNaN(typed) || typed <= 0) {
                return;
              }
              setAmountInputValue(
                majorUnitInput(
                  toMinorUnits({ amount: typed, currency: currentCurrency }),
                  currentCurrency,
                ),
              );
            }}
            onChange={(e) => setAmountInputValue(e.currentTarget.value)}
            placeholder="350.00"
            value={amountInputValue}
          />
        </div>
        <div className="flex w-20 flex-col gap-1.5">
          <Label>{t("common.currency")}</Label>
          <form.Field name="currency">
            {(field) => (
              <Input
                dir="ltr"
                maxLength={3}
                onChange={(e) =>
                  field.handleChange(e.currentTarget.value.toUpperCase())
                }
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>{t("common.description")}</Label>
        <form.Field name="description">
          {(field) => (
            <Textarea
              onChange={(e) => field.handleChange(e.currentTarget.value)}
              placeholder={t("billing.expenses.descriptionPlaceholder")}
              rows={3}
              value={field.state.value}
            />
          )}
        </form.Field>
      </div>

      <div className="flex gap-3">
        <form.Field name="billable">
          {(field) => (
            <div className="flex items-center gap-2">
              <Checkbox
                checked={field.state.value}
                onCheckedChange={(checked) => field.handleChange(checked)}
              />
              <Label>{t("billing.billable")}</Label>
            </div>
          )}
        </form.Field>

        <div className="flex items-center gap-2">
          <Label>{t("billing.expenses.markup")}</Label>
          <form.Field name="markup">
            {(field) => (
              <Input
                className="w-16"
                max={100}
                min={0}
                onChange={(e) => {
                  const val = Number.parseInt(e.currentTarget.value, 10);
                  field.handleChange(Number.isNaN(val) ? 0 : val);
                }}
                type="number"
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button onClick={onCancel} type="button" variant="outline">
            {t("common.cancel")}
          </Button>
        )}
        <Button type="submit">{submitLabel ?? t("common.save")}</Button>
      </div>
    </form>
  );
};
