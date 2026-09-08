import { useForm } from "@tanstack/react-form";
import { useSelector } from "@tanstack/react-store";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { EXPENSE_CATEGORIES, type ExpenseCategory } from "@stll/api-contract";
import { tryToMinorUnits } from "@stll/money";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
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

import { DatePickerPopover } from "@/components/date-picker-popover";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";
import { majorUnitInput } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/amount-input.logic";
import { DEFAULT_CURRENCY } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";
import { MatterCombobox } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-combobox";

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

  const today = localISODate();

  const schema = v.pipe(
    v.strictObject({
      matterId: v.pipe(
        v.string(),
        v.check((matterId) => matterId.length > 0, t("billing.matterRequired")),
      ),
      dateIncurred: v.string(),
      currency: v.string(),
      category: v.picklist(EXPENSE_CATEGORIES),
      description: v.string(),
      billable: v.boolean(),
      markup: v.number(),
      amountInputValue: v.string(),
    }),
    // Scale typed text against the submitted currency after validation so
    // decimal precision is preserved for minor-unit conversion.
    v.rawTransform(({ addIssue, dataset, NEVER }) => {
      const { amountInputValue, currency, ...rest } = dataset.value;
      const amount = tryToMinorUnits({
        amount: amountInputValue,
        currency,
      });
      if (amount === null || amount <= 0) {
        addIssue({
          message: t("billing.failedToSave"),
          path: [
            {
              type: "object",
              origin: "value",
              input: dataset.value,
              key: "amountInputValue",
              value: amountInputValue,
            },
          ],
        });
        return NEVER;
      }
      return { ...rest, currency, amount };
    }),
  );

  const form = useForm(
    schemaFormOptions({
      schema,
      submitValues: "schema-output",
      defaultValues: {
        matterId: defaultValues?.matterId ?? "",
        dateIncurred: defaultValues?.dateIncurred ?? today,
        currency: initialCurrency,
        category: defaultValues?.category ?? "other",
        description: defaultValues?.description ?? "",
        billable: defaultValues?.billable ?? true,
        markup: defaultValues?.markup ?? 0,
        amountInputValue:
          (defaultValues?.amount ?? 0) > 0
            ? majorUnitInput(defaultValues?.amount ?? 0, initialCurrency)
            : "",
      },
      onSubmit: async ({ value }) => {
        await onSubmit(value);
      },
    }),
  );

  const currentCurrency = useSelector(form.store, (s) => s.values.currency);
  const formErrors = useSelector(form.store, (state) =>
    toFormErrors(state.fieldMeta),
  );

  return (
    <Form
      className="flex flex-col gap-4"
      errors={formErrors}
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        detached(form.handleSubmit(), "expense-form.submit");
      }}
    >
      <form.Field name="matterId">
        {(field) => (
          <Field name={field.name}>
            <FieldLabel>{t("common.matter")}</FieldLabel>
            <MatterCombobox
              onChange={field.handleChange}
              value={field.state.value}
              workspaceId={workspaceId}
            />
            <FieldError />
          </Field>
        )}
      </form.Field>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("billing.expenses.dateIncurred")}</Label>
          <form.Field name="dateIncurred">
            {(field) => (
              <DatePickerPopover
                onChange={(value) => field.handleChange(value ?? "")}
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
                onValueChange={(value) => {
                  if (value) {
                    field.handleChange(value);
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
        <form.Field name="amountInputValue">
          {(field) => (
            <Field className="flex-1" name={field.name}>
              <FieldLabel>{t("billing.amount")}</FieldLabel>
              <Input
                dir="ltr"
                inputMode="decimal"
                onBlur={() => {
                  field.handleBlur();
                  const amount = tryToMinorUnits({
                    amount: field.state.value,
                    currency: currentCurrency,
                  });
                  if (amount === null || amount <= 0) {
                    return;
                  }
                  const normalized = majorUnitInput(amount, currentCurrency);
                  field.handleChange(normalized);
                }}
                onChange={(e) => {
                  const nextValue = e.currentTarget.value;
                  field.handleChange(nextValue);
                }}
                placeholder="350.00"
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>
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
    </Form>
  );
};
