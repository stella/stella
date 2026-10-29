import { useState } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { BILLING_MATTER_READ_PERMISSION } from "@stll/permissions";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
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
import { DEFAULT_CURRENCY } from "@/components/billing/format-currency";
import { MatterCombobox } from "@/components/billing/matter-combobox";
import { TimeEntryNarrativeField } from "@/components/billing/time-entry-narrative-field";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePermissions } from "@/hooks/use-permissions";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import type { QueryView } from "@/lib/query-view.logic";
import { queryView } from "@/lib/query-view.logic";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";
import { billingCodesOptions } from "@/lib/workspaces/queries/billing-codes";
import { resolvedRateOptions } from "@/lib/workspaces/queries/rates";

import { TimeEntryRateFields } from "./time-entry-rate-fields";

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
  defaultValues?: Partial<Omit<TimeEntryFormValues, "rateAtEntry">> & {
    rateAtEntry?: number | null;
  };
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
    rateAtEntry: v.number(),
    currency: v.string(),
  });
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

const loadedItems = <TData, TError>(view: QueryView<TData, TError>) =>
  view.type === "items" ? view.items : undefined;

type TimeEntryFormStateOptions = Pick<
  TimeEntryFormProps,
  "workspaceId" | "userId" | "onSubmit"
> & {
  defaultValues: TimeEntryFormProps["defaultValues"];
  contextState: NonNullable<TimeEntryFormProps["contextState"]>;
};

const useTimeEntryFormState = ({
  workspaceId,
  userId,
  defaultValues,
  onSubmit,
  contextState = "available",
}: TimeEntryFormStateOptions) => {
  const t = useTranslations();
  const canReadBilling = usePermissions(BILLING_MATTER_READ_PERMISSION);
  const [rateOverride, setRateOverride] = useState(
    () => (defaultValues?.rateAtEntry ?? 0) > 0,
  );
  const [rateInputValue, setRateInputValue] = useState(() =>
    initialRateInput(defaultValues),
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

  const resolvedOptions = resolvedRateOptions(workspaceId, userId, dateWorked);
  const resolvedQuery = useQuery({
    ...resolvedOptions,
    enabled: canReadBilling && (resolvedOptions.enabled ?? true),
  });
  const resolvedView = queryView(resolvedQuery);
  const resolved = loadedItems(resolvedView);

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

  return {
    t,
    canReadBilling,
    rateOverride,
    setRateOverride,
    rateInputValue,
    setRateInputValue,
    form,
    taskCodesView,
    taskCodes,
    activityCodesView,
    activityCodes,
    resolvedView,
    currentRate,
    narrativeLanguage,
    currentCurrency,
    formErrors,
    dirty,
  };
};

type BillingCodeSelectProps = {
  codes: readonly { id: string; code: string; label: string }[];
  label: string;
  value: string;
  onChange: (value: string) => void;
};

const BillingCodeSelect = ({
  codes,
  label,
  value,
  onChange,
}: BillingCodeSelectProps) => (
  <div className="flex flex-col gap-1.5">
    <Label>{label}</Label>
    <Select
      onValueChange={(nextValue) => onChange(nextValue ?? "")}
      value={value || null}
    >
      <SelectTrigger size="sm">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectPopup>
        {codes.map((code) => (
          <SelectItem
            key={code.id}
            value={code.code}
          >{`${code.code} — ${code.label}`}</SelectItem>
        ))}
      </SelectPopup>
    </Select>
  </div>
);

type TimeEntryFormActionsProps = {
  onCancel: (() => void) | undefined;
  label: string;
  disabled: boolean;
};
const TimeEntryFormActions = ({
  onCancel,
  label,
  disabled,
}: TimeEntryFormActionsProps) => {
  const t = useTranslations();
  return (
    <div className="flex justify-end gap-2">
      {onCancel && (
        <Button onClick={onCancel} type="button" variant="outline">
          {t("common.cancel")}
        </Button>
      )}
      <Button type="submit" disabled={disabled}>
        {label}
      </Button>
    </div>
  );
};

export const TimeEntryForm = ({
  workspaceId,
  userId,
  defaultValues,
  onSubmit,
  onCancel,
  submitLabel,
  contextState = "available",
}: TimeEntryFormProps) => {
  const {
    t,
    canReadBilling,
    rateOverride,
    setRateOverride,
    rateInputValue,
    setRateInputValue,
    form,
    taskCodesView,
    taskCodes,
    activityCodesView,
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
    defaultValues,
    onSubmit,
    contextState,
  });
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
        if (canReadBilling && !rateOverride && resolvedView.type !== "items") {
          return;
        }
        detached(form.handleSubmit(), "time-entry-form.submit");
      }}
    >
      <QueryViewFeedback view={taskCodesView} />
      <QueryViewFeedback view={activityCodesView} />
      {canReadBilling && <QueryViewFeedback view={resolvedView} />}
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

      {canReadBilling && (
        <TimeEntryRateFields
          currency={currentCurrency}
          rate={currentRate}
          override={rateOverride}
          draft={rateInputValue}
          onOverride={() => setRateOverride(true)}
          onDraftChange={setRateInputValue}
          onCurrencyChange={(currency) =>
            form.setFieldValue("currency", currency)
          }
        />
      )}

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
            <BillingCodeSelect
              label={t("billing.codes.taskCode")}
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
            <BillingCodeSelect
              label={t("billing.codes.activityCode")}
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

      <TimeEntryFormActions
        onCancel={onCancel}
        label={submitLabel ?? t("common.save")}
        disabled={
          canReadBilling && !rateOverride && resolvedView.type !== "items"
        }
      />
    </Form>
  );
};
