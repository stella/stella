import { useId } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { minorUnitsToDecimal, tryToMinorUnits } from "@stll/money";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { DatePickerPopover } from "@/components/date-picker-popover";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { toSafeId } from "@/lib/safe-id";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";

type InvoicePaymentDialogProps = {
  workspaceId: string;
  invoiceId: string;
  amount: number;
  currency: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPaid: () => void;
};

export const InvoicePaymentDialog = ({
  open,
  onOpenChange,
  ...props
}: InvoicePaymentDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPopup>
      {open && <PaymentForm {...props} onClose={() => onOpenChange(false)} />}
    </DialogPopup>
  </Dialog>
);

const PaymentForm = ({
  workspaceId,
  invoiceId,
  amount,
  currency,
  onPaid,
  onClose,
}: Omit<InvoicePaymentDialogProps, "open" | "onOpenChange"> & {
  onClose: () => void;
}) => {
  const t = useTranslations();
  const id = useId();
  const paymentSchema = v.strictObject({
    date: v.pipe(v.string(), v.isoDate()),
    amount: v.pipe(
      v.string(),
      v.check((value) => {
        const parsed = tryToMinorUnits({ amount: value, currency });
        return parsed !== null && parsed >= 0;
      }, t("billing.invoices.paymentInvalidAmount")),
    ),
    note: v.pipe(v.string(), v.maxLength(2000)),
    reference: v.pipe(v.string(), v.maxLength(256)),
  });
  const mutation = useMutation({
    mutationFn: async (value: v.InferOutput<typeof paymentSchema>) => {
      const paidAmountMinor = tryToMinorUnits({
        amount: value.amount,
        currency,
      });
      if (paidAmountMinor === null) {
        panic("Validated payment amount could not be parsed");
      }
      return unwrapEden(
        await api
          .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
            invoiceId: toSafeId<"invoice">(invoiceId),
          })
          .transition.post({
            action: "mark_paid",
            paidDate: value.date,
            paidAmountMinor,
            note: value.note.trim() || null,
            reference: value.reference.trim() || null,
          }),
      );
    },
    onSuccess: () => {
      onPaid();
      onClose();
    },
    onError: (error) => {
      stellaToast.add({
        type: "error",
        title: t("common.somethingWentWrong"),
        description: error.message,
      });
    },
  });
  const form = useForm(
    schemaFormOptions({
      schema: paymentSchema,
      defaultValues: {
        date: Temporal.Now.plainDateISO("UTC").toString(),
        amount: minorUnitsToDecimal(BigInt(amount), currency),
        note: "",
        reference: "",
      },
      submitValues: "schema-output",
      onSubmit: async ({ value }) => {
        await mutation.mutateAsync(value);
      },
    }),
  );
  const errors = useSelector(form.store, (state) =>
    toFormErrors(state.fieldMeta),
  );
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("billing.invoices.markPaid")}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <Form
          id={id}
          formErrors={errors}
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            detached(form.handleSubmit(), "invoice-payment.submit");
          }}
        >
          <form.Field name="date">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-date`}>
                  {t("billing.invoices.paymentDate")}
                </FieldLabel>
                <DatePickerPopover
                  id={`${id}-date`}
                  value={field.state.value}
                  onChange={(value) => field.handleChange(value ?? "")}
                />
                <FieldError errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>
          <form.Field name="amount">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-amount`}>
                  {t("billing.amount")} ({currency})
                </FieldLabel>
                <Input
                  id={`${id}-amount`}
                  inputMode="decimal"
                  dir="ltr"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError errors={field.state.meta.errors} />
              </Field>
            )}
          </form.Field>
          <form.Field name="reference">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-reference`}>
                  {t("common.reference")}
                </FieldLabel>
                <Input
                  id={`${id}-reference`}
                  maxLength={256}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="note">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={`${id}-note`}>
                  {t("common.notes")}
                </FieldLabel>
                <Textarea
                  id={`${id}-note`}
                  maxLength={2000}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </Form>
      </DialogPanel>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" form={id} disabled={mutation.isPending}>
          {t("billing.invoices.markPaid")}
        </Button>
      </DialogFooter>
    </>
  );
};
