import { useId } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useFormatter, useTranslations } from "use-intl";
import * as v from "valibot";

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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import type {
  NumberSeries,
  NumberSeriesInput,
} from "@/lib/organization/number-series";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";

import {
  DEFAULT_NUMBER_SERIES_PATTERN,
  NUMBER_SERIES_PADDING_OPTIONS,
  numberSeriesFormSchema,
} from "./number-series-form.logic";
import { NumberSeriesSellerPicker } from "./number-series-seller-picker";

const DOCUMENT_TYPE_LABELS = {
  invoice: "billing.numberSeries.invoice",
  advance: "billing.numberSeries.advance",
  credit_note: "billing.numberSeries.creditNote",
} as const satisfies Record<NumberSeriesInput["documentType"], TranslationKey>;

type NumberSeriesFormProps = {
  series?: NumberSeries;
  pending: boolean;
  onSubmit: (values: NumberSeriesInput) => Promise<void>;
  onCancel: () => void;
};
export const NumberSeriesForm = ({
  series,
  pending,
  onSubmit,
  onCancel,
}: NumberSeriesFormProps) => {
  const t = useTranslations();
  const id = useId();
  const format = useFormatter();
  const schema = numberSeriesFormSchema({
    required: t("common.required"),
    invalidField: t("errors.actionFailed"),
  });
  const form = useForm(
    schemaFormOptions({
      schema,
      submitValues: "schema-output",
      defaultValues: {
        name: series?.name ?? "",
        documentType: series?.documentType ?? "invoice",
        pattern: series?.pattern ?? DEFAULT_NUMBER_SERIES_PATTERN,
        padding: series?.padding ?? 4,
        sellerProfileId: series?.sellerProfileId ?? null,
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
  const isSubmitting = useSelector(form.store, (state) => state.isSubmitting);
  const disabled = pending || isSubmitting;

  return (
    <Form
      dirty={dirty}
      onDiscard={() => form.reset()}
      errors={errors}
      onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) {
          detached(form.handleSubmit(), "number-series-form.submit");
        }
      }}
    >
      <DialogPanel>
        <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-4">
          <form.Field name="name">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel htmlFor={`${id}-name`}>
                  {t("billing.numberSeries.name")}
                </FieldLabel>
                <Input
                  id={`${id}-name`}
                  maxLength={128}
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
          <form.Field name="documentType">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel htmlFor={`${id}-type`}>
                  {t("billing.numberSeries.documentType")}
                </FieldLabel>
                {series ? (
                  <output id={`${id}-type`} className="text-sm">
                    {t(DOCUMENT_TYPE_LABELS[series.documentType])}
                  </output>
                ) : (
                  <Select
                    value={field.state.value}
                    onValueChange={(value) => {
                      if (v.is(schema.entries.documentType, value)) {
                        field.handleChange(value);
                      }
                    }}
                  >
                    <SelectTrigger id={`${id}-type`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {Object.entries(DOCUMENT_TYPE_LABELS).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {t(label)}
                          </SelectItem>
                        ),
                      )}
                    </SelectPopup>
                  </Select>
                )}
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="pattern">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel htmlFor={`${id}-pattern`}>
                  {t("billing.numberSeries.pattern")}
                </FieldLabel>
                <Input
                  id={`${id}-pattern`}
                  dir="ltr"
                  maxLength={128}
                  required
                  onBlur={field.handleBlur}
                  onChange={(event) =>
                    field.handleChange(event.currentTarget.value)
                  }
                  value={field.state.value}
                />
                <FieldDescription>
                  {t("billing.numberSeries.patternHelp")}{" "}
                  <code dir="ltr">{"{SEQ}, {YYYY}, {YY}, {MM}"}</code>
                </FieldDescription>
                {series && (
                  <FieldDescription>
                    {t("billing.numberSeries.editRestriction")}
                  </FieldDescription>
                )}
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="padding">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel htmlFor={`${id}-padding`}>
                  {t("billing.numberSeries.padding")}
                </FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => {
                    if (v.is(schema.entries.padding, value)) {
                      field.handleChange(value);
                    }
                  }}
                >
                  <SelectTrigger id={`${id}-padding`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {NUMBER_SERIES_PADDING_OPTIONS.map((value) => (
                      <SelectItem key={value} value={value}>
                        {format.number(value)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="sellerProfileId">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel htmlFor={`${id}-seller`}>
                  {t("billing.numberSeries.sellerProfile")}
                </FieldLabel>
                <NumberSeriesSellerPicker
                  id={`${id}-seller`}
                  disabled={disabled}
                  value={field.state.value}
                  onChange={field.handleChange}
                />
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
