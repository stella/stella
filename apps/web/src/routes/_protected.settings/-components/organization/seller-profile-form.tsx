import { useId } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DialogFooter, DialogPanel } from "@stll/ui/dialog";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { Textarea } from "@stll/ui/textarea";
import { cn } from "@stll/ui/utils";

import { DEFAULT_CURRENCY } from "@/components/billing/format-currency";
import { detached } from "@/lib/detached";
import type {
  SellerProfile,
  SellerProfileInput,
} from "@/lib/organization/seller-profiles";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";

import {
  SELLER_PROFILE_FIELDS,
  SELLER_PROFILE_LIMITS,
  sellerProfileFormSchema,
} from "./seller-profile-form.logic";

const FIELD_LABELS = {
  legalName: "billing.sellerProfiles.legalName",
  registrationId: "billing.sellerProfiles.registrationId",
  vatId: "billing.sellerProfiles.vatId",
  addressLine1: "contacts.importStudio.fields.address_line_1",
  addressLine2: "contacts.importStudio.fields.address_line_2",
  city: "contacts.fields.billingAddressCity",
  postalCode: "contacts.fields.billingAddressPostalCode",
  country: "common.country",
  iban: "common.anonymizationLabels.iban",
  bic: "billing.sellerProfiles.bic",
  accountNumber: "common.anonymizationLabels.bankAccountNumber",
  defaultCurrency: "billing.sellerProfiles.defaultCurrency",
  footerNotes: "billing.sellerProfiles.footerNotes",
} as const satisfies Record<keyof SellerProfileInput, string>;

type SellerProfileFormProps = {
  profile?: SellerProfile;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (values: SellerProfileInput) => Promise<void>;
};

export const SellerProfileForm = ({
  profile,
  pending,
  onCancel,
  onSubmit,
}: SellerProfileFormProps) => {
  const t = useTranslations();
  const id = useId();
  const schema = sellerProfileFormSchema({
    required: t("common.required"),
    invalidField: t("errors.actionFailed"),
    invalidIban: t("billing.sellerProfiles.invalidIban"),
    invalidBic: t("billing.sellerProfiles.invalidBic"),
    invalidCurrency: t("billing.sellerProfiles.invalidCurrency"),
  });
  const form = useForm(
    schemaFormOptions({
      schema,
      submitValues: "schema-output",
      defaultValues: {
        legalName: profile?.legalName ?? "",
        registrationId: profile?.registrationId ?? "",
        vatId: profile?.vatId ?? "",
        addressLine1: profile?.addressLine1 ?? "",
        addressLine2: profile?.addressLine2 ?? "",
        city: profile?.city ?? "",
        postalCode: profile?.postalCode ?? "",
        country: profile?.country ?? "",
        iban: profile?.iban ?? "",
        bic: profile?.bic ?? "",
        accountNumber: profile?.accountNumber ?? "",
        defaultCurrency: profile?.defaultCurrency ?? DEFAULT_CURRENCY,
        footerNotes: profile?.footerNotes ?? "",
      },
      onSubmit: async ({ value }) => {
        if (pending) {
          return;
        }
        await onSubmit(value);
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
      className="flex flex-col gap-4"
      errors={errors}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled) {
          return;
        }
        detached(form.handleSubmit(), "seller-profile-form.submit");
      }}
    >
      <DialogPanel>
        <fieldset
          className="grid min-w-0 gap-4 sm:grid-cols-2"
          disabled={disabled}
        >
          {SELLER_PROFILE_FIELDS.map((name) => (
            <form.Field key={name} name={name}>
              {(field) => (
                <Field
                  name={field.name}
                  className={cn(name === "footerNotes" && "sm:col-span-2")}
                >
                  <FieldLabel htmlFor={`${id}-${name}`}>
                    {t(FIELD_LABELS[name])}
                  </FieldLabel>
                  {name === "footerNotes" ? (
                    <Textarea
                      id={`${id}-${name}`}
                      maxLength={SELLER_PROFILE_LIMITS[name]}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.currentTarget.value)
                      }
                      rows={3}
                      value={field.state.value}
                    />
                  ) : (
                    <Input
                      id={`${id}-${name}`}
                      dir={
                        name === "iban" ||
                        name === "bic" ||
                        name === "accountNumber" ||
                        name === "defaultCurrency"
                          ? "ltr"
                          : undefined
                      }
                      maxLength={SELLER_PROFILE_LIMITS[name]}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.currentTarget.value)
                      }
                      required={
                        name === "legalName" || name === "defaultCurrency"
                      }
                      value={field.state.value}
                    />
                  )}
                  <FieldError />
                </Field>
              )}
            </form.Field>
          ))}
        </fieldset>
      </DialogPanel>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={disabled}>
          {t("common.save")}
        </Button>
      </DialogFooter>
    </Form>
  );
};
