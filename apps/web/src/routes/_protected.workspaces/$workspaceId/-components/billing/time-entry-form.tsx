import { useState } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

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

import {
  majorUnitInput,
  submittedRateCents,
} from "@/components/billing/amount-input.logic";
import { DurationInput } from "@/components/billing/duration-input";
import {
  DEFAULT_CURRENCY,
  formatCurrencyAmount,
} from "@/components/billing/format-currency";
import { MatterCombobox } from "@/components/billing/matter-combobox";
import { TimeEntryNarrativeField } from "@/components/billing/time-entry-narrative-field";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";
import { billingCodesOptions } from "@/lib/workspaces/queries/billing-codes";
import { resolvedRateOptions } from "@/lib/workspaces/queries/rates";

export type TimeEntryFormValues = {
  matterId: string;
  dateWorked: string;
  durationMinutes: number;
  narrative: string;
  narrativeLanguage: string | null;
  invoiceNarrative?: string;
  billable: boolean;
  taskCode?: string;
  activityCode?: string;
  rateAtEntry: number;
  currency: string;
};

type TimeEntryFormProps = {
  workspaceId: string;
  userId: string;
  defaultValues?: Partial<TimeEntryFormValues>;
  onSubmit: (values: TimeEntryFormValues) => void | Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
};

const initialRateInput = (entry: TimeEntryFormProps["defaultValues"]) =>
  (entry?.rateAtEntry ?? 0) > 0
    ? majorUnitInput(
        entry?.rateAtEntry ?? 0,
        entry?.currency ?? DEFAULT_CURRENCY,
      )
    : "";

const initialTimeEntryValues = (
  entry: TimeEntryFormProps["defaultValues"],
) => ({
  matterId: entry?.matterId ?? "",
  dateWorked: entry?.dateWorked ?? localISODate(),
  durationMinutes: entry?.durationMinutes ?? 6,
  narrative: entry?.narrative ?? "",
  narrativeLanguage: entry?.narrativeLanguage ?? null,
  invoiceNarrative: entry?.invoiceNarrative ?? "",
  billable: entry?.billable ?? true,
  taskCode: entry?.taskCode ?? "",
  activityCode: entry?.activityCode ?? "",
  rateAtEntry: entry?.rateAtEntry ?? 0,
  currency: entry?.currency ?? DEFAULT_CURRENCY,
});

export const TimeEntryForm = ({
  workspaceId,
  userId,
  defaultValues,
  onSubmit,
  onCancel,
  submitLabel,
}: TimeEntryFormProps) => {
  const t = useTranslations();
  const [rateOverride, setRateOverride] = useState(
    () => (defaultValues?.rateAtEntry ?? 0) > 0,
  );
  const [rateInputValue, setRateInputValue] = useState(() =>
    initialRateInput(defaultValues),
  );

  const { data: taskCodes } = useQuery(
    billingCodesOptions(workspaceId, "task"),
  );
  const { data: activityCodes } = useQuery(
    billingCodesOptions(workspaceId, "activity"),
  );

  const schema = v.strictObject({
    matterId: v.pipe(v.string(), v.nonEmpty(t("billing.matterRequired"))),
    dateWorked: v.string(),
    durationMinutes: v.number(),
    narrative: v.string(),
    narrativeLanguage: v.nullable(v.string()),
    invoiceNarrative: v.string(),
    billable: v.boolean(),
    taskCode: v.string(),
    activityCode: v.string(),
    rateAtEntry: v.number(),
    currency: v.string(),
  });

  const form = useForm(
    schemaFormOptions({
      schema,
      submitValues: "raw",
      defaultValues: initialTimeEntryValues(defaultValues),
      onSubmit: async ({ value }) => {
        // The rate input holds MAJOR units and the currency input sits beside
        // it, so an overridden rate is scaled here, against the currency the
        // form actually submits: 100 typed under USD and submitted under JPY is
        // 100 yen. A rate that was never overridden already carries its rate
        // table's currency, in that currency's minor units.
        await onSubmit({
          ...value,
          rateAtEntry: submittedRateCents({
            draft: rateOverride ? rateInputValue : null,
            currency: value.currency,
            resolvedRateCents: value.rateAtEntry,
          }),
        });
      },
    }),
  );

  const dateWorked = useSelector(form.store, (s) => s.values.dateWorked);

  const { data: resolved } = useQuery(
    resolvedRateOptions(workspaceId, userId, dateWorked),
  );

  // Resolved rates are automatic defaults, not unsaved user changes.
  // Sync the external form store until the user overrides the rate.
  useExternalSyncEffect(() => {
    if (rateOverride) {
      return;
    }
    if (resolved && resolved.hourlyRate !== null && resolved.currency) {
      form.setFieldValue("rateAtEntry", resolved.hourlyRate);
      form.setFieldValue("currency", resolved.currency);
    }
  }, [resolved, rateOverride, form]);

  const currentRate = useSelector(form.store, (s) => s.values.rateAtEntry);
  const narrativeLanguage = useSelector(
    form.store,
    (s) => s.values.narrativeLanguage,
  );
  const currentCurrency = useSelector(form.store, (s) => s.values.currency);
  const { formErrors, dirty } = useSelector(form.store, (state) => ({
    formErrors: toFormErrors(state.fieldMeta),
    dirty:
      Object.entries(state.fieldMeta).some(
        ([name, meta]) =>
          !meta.isDefaultValue &&
          (rateOverride || (name !== "rateAtEntry" && name !== "currency")),
      ) || rateInputValue !== initialRateInput(defaultValues),
  }));

  return (
    <Form
      dirty={dirty}
      onDiscard={() => {
        form.reset();
        setRateOverride((defaultValues?.rateAtEntry ?? 0) > 0);
        setRateInputValue(initialRateInput(defaultValues));
      }}
      className="flex flex-col gap-4"
      errors={formErrors}
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        detached(form.handleSubmit(), "time-entry-form.submit");
      }}
    >
      <div className="flex flex-col gap-1.5">
        <form.Field name="matterId">
          {(field) => (
            <Field className="w-full gap-1.5" name={field.name}>
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
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("common.date")}</Label>
          <form.Field name="dateWorked">
            {(field) => (
              <DatePickerPopover
                onChange={(value) => field.handleChange(value ?? "")}
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>

        <div className="flex flex-1 flex-col gap-1.5">
          <Label id="billing-time-entry-duration-label">
            {t("billing.duration")}
          </Label>
          <form.Field name="durationMinutes">
            {(field) => (
              <DurationInput
                id="billing-time-entry-duration"
                labelledBy="billing-time-entry-duration-label"
                onChange={field.handleChange}
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>
      </div>

      {/* Rate display / override */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <Label>{t("billing.rates.hourlyRate")}</Label>
          {!rateOverride && currentRate > 0 && (
            <button
              className="text-muted-foreground text-xs underline"
              onClick={() => setRateOverride(true)}
              type="button"
            >
              {t("billing.rates.override")}
            </button>
          )}
        </div>
        {rateOverride ? (
          <div className="flex gap-2">
            <Input
              className="flex-1"
              dir="ltr"
              inputMode="decimal"
              onBlur={() => {
                // Display only: tidy the draft to the places the currency
                // counts. The draft stays in major units, and the scaling
                // that reaches the API waits for submit.
                const rate = tryToMinorUnits({
                  amount: rateInputValue,
                  currency: currentCurrency,
                });
                if (rate === null) {
                  return;
                }
                setRateInputValue(majorUnitInput(rate, currentCurrency));
              }}
              onChange={(e) => setRateInputValue(e.currentTarget.value)}
              placeholder="350.00"
              value={rateInputValue}
            />
            <form.Field name="currency">
              {(field) => (
                <Input
                  className="w-20"
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
        ) : (
          <div className="text-muted-foreground text-sm">
            {currentRate > 0
              ? `${formatCurrencyAmount(currentRate, currentCurrency)}${t("billing.rates.perHour")}`
              : t("billing.rates.noRateFound")}
          </div>
        )}
      </div>

      <form.Field name="narrative">
        {(field) => (
          <TimeEntryNarrativeField
            id="billing-time-entry-narrative"
            onChange={field.handleChange}
            onLanguageChange={(language) =>
              form.setFieldValue("narrativeLanguage", language)
            }
            narrativeLanguage={narrativeLanguage}
            rows={3}
            value={field.state.value}
            workspaceId={workspaceId}
          />
        )}
      </form.Field>

      <div className="flex flex-col gap-1.5">
        <Label>{t("billing.invoiceNarrative")}</Label>
        <form.Field name="invoiceNarrative">
          {(field) => (
            <Textarea
              onChange={(e) => field.handleChange(e.currentTarget.value)}
              placeholder={t("billing.invoiceNarrativePlaceholder")}
              rows={2}
              value={field.state.value}
            />
          )}
        </form.Field>
      </div>

      {taskCodes && taskCodes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>{t("billing.codes.taskCode")}</Label>
          <form.Field name="taskCode">
            {(field) => (
              <Select
                onValueChange={(value) => field.handleChange(value ?? "")}
                value={field.state.value || null}
              >
                <SelectTrigger size="sm">
                  <SelectValue placeholder={t("billing.codes.taskCode")} />
                </SelectTrigger>
                <SelectPopup>
                  {taskCodes.map((tc) => (
                    <SelectItem key={tc.id} value={tc.code}>
                      {`${tc.code} — ${tc.label}`}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </form.Field>
        </div>
      )}

      {activityCodes && activityCodes.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label>{t("billing.codes.activityCode")}</Label>
          <form.Field name="activityCode">
            {(field) => (
              <Select
                onValueChange={(value) => field.handleChange(value ?? "")}
                value={field.state.value || null}
              >
                <SelectTrigger size="sm">
                  <SelectValue placeholder={t("billing.codes.activityCode")} />
                </SelectTrigger>
                <SelectPopup>
                  {activityCodes.map((ac) => (
                    <SelectItem key={ac.id} value={ac.code}>
                      {`${ac.code} — ${ac.label}`}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            )}
          </form.Field>
        </div>
      )}

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
