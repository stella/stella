import { useState } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { CURRENCY_CODE_LENGTH } from "@stll/api-contract/currency-code";
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

import { majorUnitInput } from "@/components/billing/amount-input.logic";
import { DurationInput } from "@/components/billing/duration-input";
import {
  DEFAULT_CURRENCY,
  formatCurrencyAmount,
} from "@/components/billing/format-currency";
import { MatterCombobox } from "@/components/billing/matter-combobox";
import { TimeEntryNarrativeField } from "@/components/billing/time-entry-narrative-field";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import type { QueryView } from "@/lib/query-view.logic";
import { queryView } from "@/lib/query-view.logic";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";
import { billingCodesOptions } from "@/lib/workspaces/queries/billing-codes";
import { resolvedRateOptions } from "@/lib/workspaces/queries/rates";

import { deriveTimeEntryPricing } from "./time-entry-pricing.logic";
import type { TimeEntryPricingSelection } from "./time-entry-pricing.logic";

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
  contextState?: "available" | "unavailable";
};

const timeEntryFormSchema = (
  contextState: "available" | "unavailable",
  matterRequired: string,
) =>
  v.strictObject({
    matterId: v.pipe(
      v.string(),
      v.check(
        (value) => value.length > 0 || contextState === "unavailable",
        matterRequired,
      ),
    ),
    dateWorked: v.string(),
    durationMinutes: v.number(),
    narrative: v.string(),
    narrativeLanguage: v.nullable(v.string()),
    invoiceNarrative: v.string(),
    billable: v.boolean(),
    taskCode: v.string(),
    activityCode: v.string(),
  });
const initialPricingSelection = (
  entry: TimeEntryFormProps["defaultValues"],
): TimeEntryPricingSelection =>
  (entry?.rateAtEntry ?? 0) > 0
    ? {
        type: "manual",
        draft: majorUnitInput(
          entry?.rateAtEntry ?? 0,
          entry?.currency ?? DEFAULT_CURRENCY,
        ),
        currency: entry?.currency ?? DEFAULT_CURRENCY,
      }
    : { type: "automatic" };

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
});

const loadedItems = <TData, TError>(view: QueryView<TData, TError>) =>
  view.type === "items" ? view.items : undefined;

export const TimeEntryForm = ({
  workspaceId,
  userId,
  defaultValues,
  onSubmit,
  onCancel,
  submitLabel,
  contextState = "available",
}: TimeEntryFormProps) => {
  const t = useTranslations();
  const {
    form,
    rateOverride,
    beginOverride,
    rateInputValue,
    setRateInputValue,
    setManualCurrency,
    resetPricing,
    pricingStatus,
    taskCodesView,
    activityCodesView,
    taskCodes,
    activityCodes,
    resolvedView,
    currentRate,
    narrativeLanguage,
    currentCurrency,
    formErrors,
    dirty,
  } = useTimeEntryFormState({
    workspaceId,
    userId,
    ...(defaultValues && { defaultValues }),
    onSubmit,
    contextState,
  });

  return (
    <Form
      dirty={dirty}
      onDiscard={() => {
        form.reset();
        resetPricing();
      }}
      className="flex flex-col gap-4"
      errors={formErrors}
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pricingStatus !== "ready") {
          return;
        }
        detached(form.handleSubmit(), "time-entry-form.submit");
      }}
    >
      <QueryViewFeedback view={taskCodesView} />
      <QueryViewFeedback view={activityCodesView} />
      <QueryViewFeedback view={resolvedView} />
      <div className="flex flex-col gap-1.5">
        <form.Field name="matterId">
          {(field) => (
            <Field className="w-full gap-1.5" name={field.name}>
              <FieldLabel>{t("common.matter")}</FieldLabel>
              <MatterCombobox
                onChange={field.handleChange}
                {...(contextState === "unavailable" && field.state.value === ""
                  ? { placeholder: t("common.unavailable") }
                  : {})}
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

      <TimeEntryRateInput
        currentCurrency={currentCurrency}
        currentRate={currentRate}
        rateOverride={rateOverride}
        rateInputValue={rateInputValue}
        onCurrencyChange={setManualCurrency}
        beginOverride={beginOverride}
        setRateInputValue={setRateInputValue}
      />

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
        <form.Field name="taskCode">
          {(field) => (
            <TimeEntryCodeSelect
              type="task"
              codes={taskCodes}
              value={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
      )}
      {activityCodes && activityCodes.length > 0 && (
        <form.Field name="activityCode">
          {(field) => (
            <TimeEntryCodeSelect
              type="activity"
              codes={activityCodes}
              value={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </form.Field>
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
        <Button type="submit" disabled={pricingStatus !== "ready"}>
          {submitLabel ?? t("common.save")}
        </Button>
      </div>
    </Form>
  );
};

const TimeEntryRateInput = ({
  currentCurrency,
  currentRate,
  rateOverride,
  rateInputValue,
  onCurrencyChange,
  beginOverride,
  setRateInputValue,
}: {
  currentCurrency: string;
  currentRate: number;
  rateOverride: boolean;
  rateInputValue: string;
  onCurrencyChange: (value: string) => void;
  beginOverride: () => void;
  setRateInputValue: (value: string) => void;
}) => {
  const t = useTranslations();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label>{t("billing.rates.hourlyRate")}</Label>
        {!rateOverride && (
          <button
            className="text-muted-foreground text-xs underline"
            onClick={beginOverride}
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
          <Input
            className="w-20"
            dir="ltr"
            maxLength={CURRENCY_CODE_LENGTH}
            onChange={(event) =>
              onCurrencyChange(event.currentTarget.value.toUpperCase())
            }
            value={currentCurrency}
          />
        </div>
      ) : (
        <div className="text-muted-foreground text-sm">
          {currentRate > 0
            ? `${formatCurrencyAmount(currentRate, currentCurrency)}${t("billing.rates.perHour")}`
            : t("billing.rates.noRateFound")}
        </div>
      )}
    </div>
  );
};

const TimeEntryCodeSelect = ({
  type,
  codes,
  value,
  onChange,
}: {
  type: "task" | "activity";
  codes: { id: string; code: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
}) => {
  const t = useTranslations();
  const label = t(`billing.codes.${type}Code`);
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select
        onValueChange={(selected) => onChange(selected ?? "")}
        value={value || null}
      >
        <SelectTrigger aria-label={label} size="sm">
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectPopup>
          {codes.map((code) => (
            <SelectItem key={code.id} value={code.code}>
              <bdi>{code.code}</bdi>: {code.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
};

const useTimeEntryFormState = ({
  workspaceId,
  userId,
  defaultValues,
  onSubmit,
  contextState = "available",
}: TimeEntryFormProps) => {
  const t = useTranslations();
  const queryClient = useQueryClient();
  const [pricingSelection, setPricingSelection] = useState(() =>
    initialPricingSelection(defaultValues),
  );

  const taskCodesQuery = useQuery(billingCodesOptions(workspaceId, "task"));
  const taskCodesView = queryView(taskCodesQuery);
  const taskCodes = loadedItems(taskCodesView);
  const activityCodesQuery = useQuery(
    billingCodesOptions(workspaceId, "activity"),
  );
  const activityCodesView = queryView(activityCodesQuery);
  const activityCodes = loadedItems(activityCodesView);

  const form = useForm(
    schemaFormOptions({
      schema: timeEntryFormSchema(contextState, t("billing.matterRequired")),
      submitValues: "raw",
      defaultValues: initialTimeEntryValues(defaultValues),
      onSubmit: async ({ value }) => {
        // Read the exact submitted lookup again: validation may outlive a render.
        const pricing = deriveTimeEntryPricing({
          selection: pricingSelection,
          lookup: queryClient.getQueryState(
            resolvedRateOptions({
              workspaceId,
              userId,
              date: value.dateWorked,
              activityCode: value.activityCode,
            }).queryKey,
          ),
        });
        if (pricing.status !== "ready") {
          return;
        }
        await onSubmit({
          ...value,
          rateAtEntry: pricing.rateAtEntry,
          currency: pricing.currency,
        });
      },
    }),
  );

  const dateWorked = useSelector(form.store, (s) => s.values.dateWorked);

  const activityCode = useSelector(form.store, (s) => s.values.activityCode);

  const resolvedQuery = useQuery(
    resolvedRateOptions({
      workspaceId,
      userId,
      date: dateWorked,
      activityCode,
    }),
  );
  const resolvedView = queryView(resolvedQuery);
  const pricing = deriveTimeEntryPricing({
    selection: pricingSelection,
    lookup: resolvedQuery.isPlaceholderData ? undefined : resolvedQuery,
  });
  const currentRate = pricing.rateAtEntry;
  const currentCurrency = pricing.currency;
  const rateOverride = pricingSelection.type === "manual";
  const rateInputValue =
    pricingSelection.type === "manual" ? pricingSelection.draft : "";
  const initialSelection = initialPricingSelection(defaultValues);
  const pricingDirty =
    pricingSelection.type !== initialSelection.type ||
    (pricingSelection.type === "manual" &&
      initialSelection.type === "manual" &&
      (pricingSelection.draft !== initialSelection.draft ||
        pricingSelection.currency !== initialSelection.currency));

  const narrativeLanguage = useSelector(
    form.store,
    (s) => s.values.narrativeLanguage,
  );
  const { formErrors, dirty } = useSelector(form.store, (state) => ({
    formErrors: toFormErrors(state.fieldMeta),
    dirty:
      Object.values(state.fieldMeta).some((meta) => !meta.isDefaultValue) ||
      pricingDirty,
  }));

  return {
    form,
    rateOverride,
    beginOverride: () =>
      setPricingSelection({
        type: "manual",
        currency: currentCurrency,
        draft:
          currentRate > 0 ? majorUnitInput(currentRate, currentCurrency) : "",
      }),
    rateInputValue,
    setRateInputValue: (draft: string) =>
      setPricingSelection({ type: "manual", currency: currentCurrency, draft }),
    setManualCurrency: (currency: string) =>
      setPricingSelection({ type: "manual", currency, draft: rateInputValue }),
    resetPricing: () =>
      setPricingSelection(initialPricingSelection(defaultValues)),
    pricingStatus: pricing.status,
    taskCodesView,
    activityCodesView,
    taskCodes,
    activityCodes,
    resolvedView,
    currentRate,
    narrativeLanguage,
    currentCurrency,
    formErrors,
    dirty,
  };
};
