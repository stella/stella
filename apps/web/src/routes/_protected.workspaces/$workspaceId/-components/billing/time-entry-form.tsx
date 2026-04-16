import { useEffect, useState } from "react";

import { useForm, useStore } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Checkbox } from "@stella/ui/components/checkbox";
import { Input } from "@stella/ui/components/input";
import { Label } from "@stella/ui/components/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stella/ui/components/select";
import { Textarea } from "@stella/ui/components/textarea";
import { toastManager } from "@stella/ui/components/toast";

import { DurationInput } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/duration-input";
import { formatCurrencyAmount } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";
import { MatterCombobox } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/matter-combobox";
import { billingCodesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/billing-codes";
import { resolvedRateOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/rates";

export type TimeEntryFormValues = {
  matterId: string;
  dateWorked: string;
  durationMinutes: number;
  narrative: string;
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
    (defaultValues?.rateAtEntry ?? 0) > 0
      ? ((defaultValues?.rateAtEntry ?? 0) / 100).toFixed(2)
      : "",
  );

  const { data: taskCodes } = useQuery(
    billingCodesOptions(workspaceId, "task"),
  );
  const { data: activityCodes } = useQuery(
    billingCodesOptions(workspaceId, "activity"),
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
      dateWorked: defaultValues?.dateWorked ?? today,
      durationMinutes: defaultValues?.durationMinutes ?? 6,
      narrative: defaultValues?.narrative ?? "",
      invoiceNarrative: defaultValues?.invoiceNarrative ?? "",
      billable: defaultValues?.billable ?? true,
      taskCode: defaultValues?.taskCode ?? "",
      activityCode: defaultValues?.activityCode ?? "",
      rateAtEntry: defaultValues?.rateAtEntry ?? 0,
      currency: defaultValues?.currency ?? "USD",
    },
    onSubmit: async ({ value }) => {
      if (!value.matterId) {
        toastManager.add({
          title: t("billing.matterRequired"),
          type: "error",
        });
        return;
      }
      await onSubmit(value);
    },
  });

  const dateWorked = useStore(form.store, (s) => s.values.dateWorked);

  const { data: resolved } = useQuery(
    resolvedRateOptions(workspaceId, userId, dateWorked),
  );

  // Auto-fill rate when resolved and not overridden
  useEffect(() => {
    if (rateOverride) {
      return;
    }
    if (resolved && resolved.hourlyRate !== null && resolved.currency) {
      form.setFieldValue("rateAtEntry", resolved.hourlyRate);
      form.setFieldValue("currency", resolved.currency);
    }
  }, [resolved, rateOverride, form]);

  const currentRate = useStore(form.store, (s) => s.values.rateAtEntry);
  const currentCurrency = useStore(form.store, (s) => s.values.currency);

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
          <Label>{t("common.date")}</Label>
          <form.Field name="dateWorked">
            {(field) => (
              <Input
                onChange={(e) => field.handleChange(e.currentTarget.value)}
                type="date"
                value={field.state.value}
              />
            )}
          </form.Field>
        </div>

        <div className="flex flex-1 flex-col gap-1.5">
          <Label>{t("billing.duration")}</Label>
          <form.Field name="durationMinutes">
            {(field) => (
              <DurationInput
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
            <form.Field name="rateAtEntry">
              {(field) => (
                <Input
                  className="flex-1"
                  inputMode="decimal"
                  onBlur={() => {
                    const cents = Math.round(
                      Number.parseFloat(rateInputValue) * 100,
                    );
                    if (!Number.isNaN(cents)) {
                      field.handleChange(cents);
                      setRateInputValue((cents / 100).toFixed(2));
                    }
                  }}
                  onChange={(e) => setRateInputValue(e.currentTarget.value)}
                  placeholder="350.00"
                  value={rateInputValue}
                />
              )}
            </form.Field>
            <form.Field name="currency">
              {(field) => (
                <Input
                  className="w-20"
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

      <div className="flex flex-col gap-1.5">
        <Label>{t("common.description")}</Label>
        <form.Field name="narrative">
          {(field) => (
            <Textarea
              onChange={(e) => field.handleChange(e.currentTarget.value)}
              placeholder={t("billing.narrativePlaceholder")}
              rows={3}
              value={field.state.value}
            />
          )}
        </form.Field>
      </div>

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
                onValueChange={(v) => field.handleChange(v ?? "")}
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
                onValueChange={(v) => field.handleChange(v ?? "")}
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
    </form>
  );
};
