import { useState } from "react";

import { useForm } from "@tanstack/react-form";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Checkbox } from "@stll/ui/components/checkbox";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { MatterCombobox } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-combobox";

const EXPENSE_CATEGORIES = [
  "filing_fee",
  "expert_witness",
  "travel",
  "printing",
  "courier",
  "other",
] as const;

type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

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
  const [amountInputValue, setAmountInputValue] = useState(() =>
    (defaultValues?.amount ?? 0) > 0
      ? ((defaultValues?.amount ?? 0) / 100).toFixed(2)
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
      amount: defaultValues?.amount ?? 0,
      currency: defaultValues?.currency ?? "USD",
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
      if (value.amount <= 0) {
        stellaToast.add({
          title: t("billing.failedToSave"),
          type: "error",
        });
        return;
      }
      await onSubmit(value);
    },
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // eslint-disable-next-line typescript/no-floating-promises
        form.handleSubmit();
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
          <form.Field name="amount">
            {(field) => (
              <Input
                inputMode="decimal"
                onBlur={() => {
                  const cents = Math.round(
                    Number.parseFloat(amountInputValue) * 100,
                  );
                  if (!Number.isNaN(cents) && cents > 0) {
                    setAmountInputValue((cents / 100).toFixed(2));
                  }
                }}
                onChange={(e) => {
                  const raw = e.currentTarget.value;
                  setAmountInputValue(raw);
                  const cents = Math.round(Number.parseFloat(raw) * 100);
                  field.handleChange(
                    !Number.isNaN(cents) && cents > 0 ? cents : 0,
                  );
                }}
                placeholder="350.00"
                value={amountInputValue}
              />
            )}
          </form.Field>
        </div>
        <div className="flex w-20 flex-col gap-1.5">
          <Label>{t("common.currency")}</Label>
          <form.Field name="currency">
            {(field) => (
              <Input
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
