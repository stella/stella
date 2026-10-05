import { useId } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DialogFooter, DialogPanel } from "@stll/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { detached } from "@/lib/detached";
import { localISODate } from "@/lib/local-iso-date";
import type { VatRate, VatRateInput } from "@/lib/organization/vat-rates";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";

import { vatRateFormSchema, vatRatePercentInput } from "./vat-rate-form.logic";

type VatRateFormProps = {
  rate?: VatRate;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: VatRateInput) => Promise<void>;
};
export const VatRateForm = ({
  rate,
  pending,
  onCancel,
  onSubmit,
}: VatRateFormProps) => {
  const t = useTranslations();
  const id = useId();
  const form = useForm(
    schemaFormOptions({
      schema: vatRateFormSchema({
        required: t("common.required"),
        invalidField: t("errors.actionFailed"),
        invalidRate: t("billing.vatRates.invalidRate"),
        invalidPeriod: t("billing.vatRates.invalidPeriod"),
      }),
      submitValues: "schema-output",
      defaultValues: {
        code: rate?.code ?? "",
        name: rate?.name ?? "",
        ratePercent: vatRatePercentInput(rate?.rateBps ?? 0),
        validFrom: rate?.validFrom ?? localISODate(),
        validTo: rate?.validTo ?? "",
      },
      onSubmit: async ({ value }) => {
        if (!pending) {
          await onSubmit(value);
        }
      },
    }),
  );
  const { errors, dirty } = useSelector(form.store, (state) => ({
    errors: toFormErrors(state.fieldMeta),
    dirty: !state.isDefaultValue,
  }));
  const submitting = useSelector(form.store, (state) => state.isSubmitting);
  const disabled = pending || submitting;

  return (
    <Form
      dirty={dirty}
      onDiscard={() => form.reset()}
      errors={errors}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) {
          detached(form.handleSubmit(), "vat-rate-form.submit");
        }
      }}
    >
      <DialogPanel>
        <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4">
          <form.Field name="code">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel htmlFor={`${id}-code`}>
                  {t("billing.vatRates.code")}
                </FieldLabel>
                <Input
                  id={`${id}-code`}
                  required
                  maxLength={64}
                  onBlur={field.handleBlur}
                  onChange={(event) =>
                    field.handleChange(event.currentTarget.value)
                  }
                  value={field.state.value}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="name">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel htmlFor={`${id}-name`}>
                  {t("billing.vatRates.name")}
                </FieldLabel>
                <Input
                  id={`${id}-name`}
                  required
                  maxLength={128}
                  onBlur={field.handleBlur}
                  onChange={(event) =>
                    field.handleChange(event.currentTarget.value)
                  }
                  value={field.state.value}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="ratePercent">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel htmlFor={`${id}-rate`}>
                  {t("billing.vatRates.rate")}
                </FieldLabel>
                <Input
                  id={`${id}-rate`}
                  dir="ltr"
                  inputMode="decimal"
                  required
                  onBlur={field.handleBlur}
                  onChange={(event) =>
                    field.handleChange(event.currentTarget.value)
                  }
                  value={field.state.value}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="validFrom">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel id={`${id}-from-label`} htmlFor={`${id}-from`}>
                  {t("billing.vatRates.validFrom")}
                </FieldLabel>
                <DatePickerPopover
                  id={`${id}-from`}
                  labelledBy={`${id}-from-label`}
                  onChange={(date) => {
                    if (!disabled) {
                      field.handleChange(date ?? "");
                    }
                  }}
                  value={field.state.value}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="validTo">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel id={`${id}-to-label`} htmlFor={`${id}-to`}>
                  {t("billing.vatRates.validTo")}
                </FieldLabel>
                <DatePickerPopover
                  id={`${id}-to`}
                  labelledBy={`${id}-to-label`}
                  onChange={(date) => {
                    if (!disabled) {
                      field.handleChange(date ?? "");
                    }
                  }}
                  value={field.state.value || null}
                />
                <FieldDescription>
                  {t("billing.vatRates.periodHelp")}
                </FieldDescription>
                <FieldError />
              </Field>
            )}
          </form.Field>
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <Button
          disabled={disabled}
          type="button"
          variant="outline"
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
        <Button disabled={disabled} type="submit">
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Form>
  );
};
