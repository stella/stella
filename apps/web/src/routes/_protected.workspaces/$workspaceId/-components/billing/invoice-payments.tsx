import { useId } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  INVOICE_PAYMENT_INPUT_LIMITS,
  INVOICE_PAYMENT_METHODS,
  type InvoicePaymentMethod,
} from "@stll/api-contract";
import { tryToMinorUnits } from "@stll/money";
import { Button } from "@stll/ui/button";
import { Dialog, DialogPopup } from "@stll/ui/dialog";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { PlusIcon, XCircleIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";

import { majorUnitInput } from "@/components/billing/amount-input.logic";
import { formatCurrencyAmount } from "@/components/billing/format-currency";
import {
  MEDIUM_DATE,
  plainDateEpoch,
} from "@/components/billing/format-plain-date";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { localISODate } from "@/lib/local-iso-date";
import { allInvoicesQueryRoot } from "@/lib/resource-query-roots.logic";
import { toSafeId } from "@/lib/safe-id";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";
import type { invoiceByIdOptions } from "@/lib/workspaces/queries/invoices";
import { ConfirmAction } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/confirm-action";
import {
  checkPaymentAmount,
  invoiceTakesPayments,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-payments.logic";

type InvoiceDetail = Awaited<
  ReturnType<NonNullable<ReturnType<typeof invoiceByIdOptions>["queryFn"]>>
>;

const DEFAULT_PAYMENT_METHOD: InvoicePaymentMethod = "bank_transfer";

/** Payments are recorded on a finalized or sent invoice that still owes. */
const canRecordInvoicePayment = (invoice: {
  status: InvoiceDetail["status"];
  outstandingAmount: number;
}) => invoiceTakesPayments(invoice.status) && invoice.outstandingAmount > 0;

const useInvalidateInvoices = () => {
  const queryClient = useQueryClient();
  return () =>
    detached(
      queryClient.invalidateQueries({ queryKey: allInvoicesQueryRoot() }),
      "invoice-payments.invalidate",
    );
};

type InvoicePaymentsSectionProps = {
  workspaceId: string;
  invoiceId: string;
  invoice: Pick<
    InvoiceDetail,
    "currency" | "payments" | "paidAmount" | "outstandingAmount" | "status"
  >;
  canUpdate: boolean;
  onRecord: () => void;
};

/** The invoice's payments, newest last, with void and record actions. */
export const InvoicePaymentsSection = ({
  workspaceId,
  invoiceId,
  invoice,
  canUpdate,
  onRecord,
}: InvoicePaymentsSectionProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const invalidate = useInvalidateInvoices();
  const voidMutation = useMutation({
    mutationFn: async (paymentId: string) =>
      unwrapApiResponse(
        await invokeCapability("invoices.payments.void", async (request) =>
          api
            .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
              invoiceId: toSafeId<"invoice">(invoiceId),
            })
            .payments({ paymentId: toSafeId<"invoicePayment">(paymentId) })
            .void.post({}, request),
        ),
      ),
    onSuccess: invalidate,
    onError: (error) => notifyUserError(error, t("common.somethingWentWrong")),
  });

  return (
    <section className="rounded-lg border">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <h3 className="text-sm font-medium">
          {t("billing.invoices.payments.title")}
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("billing.invoices.payments.summary", {
              paid: formatCurrencyAmount(invoice.paidAmount, invoice.currency),
              outstanding: formatCurrencyAmount(
                invoice.outstandingAmount,
                invoice.currency,
              ),
            })}
          </span>
          {canUpdate && canRecordInvoicePayment(invoice) && (
            <Button onClick={onRecord} size="sm" variant="outline">
              <PlusIcon className="size-3.5" />
              {t("billing.invoices.payments.record")}
            </Button>
          )}
        </div>
      </div>
      {invoice.payments.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">
          {t("billing.invoices.payments.empty")}
        </p>
      ) : (
        <ScrollArea>
          <Table inset="card" scroll="parent">
            <TableHeader>
              <TableRow>
                <TableHead>{t("billing.invoices.payments.paidOn")}</TableHead>
                <TableHead>{t("billing.invoices.payments.method")}</TableHead>
                <TableHead>{t("common.reference")}</TableHead>
                <TableHead align="end">{t("billing.amount")}</TableHead>
                {canUpdate && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.payments.map((payment) => {
                const voided = payment.voidedAt !== null;
                return (
                  <TableRow
                    key={payment.id}
                    tone={voided ? "muted" : "default"}
                  >
                    <TableCell align="start" numeric>
                      {format.dateTime(
                        plainDateEpoch(payment.paidOn),
                        MEDIUM_DATE,
                      )}
                    </TableCell>
                    <TableCell>
                      {t(`billing.invoices.payments.methods.${payment.method}`)}
                      {voided && (
                        <span className="ms-2 text-xs">
                          {t("billing.invoices.payments.voided")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs" dir="auto" truncate>
                      {payment.reference ?? ""}
                    </TableCell>
                    <TableCell align="end" numeric>
                      {voided ? (
                        <s>
                          {formatCurrencyAmount(
                            payment.amount,
                            invoice.currency,
                          )}
                        </s>
                      ) : (
                        formatCurrencyAmount(payment.amount, invoice.currency)
                      )}
                    </TableCell>
                    {canUpdate && (
                      <TableCell>
                        {!voided && (
                          <ConfirmAction
                            description={t(
                              "billing.invoices.payments.confirmVoid",
                            )}
                            onConfirm={() => voidMutation.mutate(payment.id)}
                          >
                            <Button
                              aria-label={t("billing.invoices.payments.void")}
                              className="size-6"
                              size="icon"
                              variant="ghost"
                            >
                              <XCircleIcon className="text-muted-foreground size-3.5" />
                            </Button>
                          </ConfirmAction>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
    </section>
  );
};

type RecordPaymentDialogProps = {
  workspaceId: string;
  invoiceId: string;
  currency: string;
  outstandingAmount: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const RecordPaymentDialog = ({
  open,
  onOpenChange,
  ...form
}: RecordPaymentDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogPopup className="max-w-md">
      {open && (
        <RecordPaymentForm {...form} onClose={() => onOpenChange(false)} />
      )}
    </DialogPopup>
  </Dialog>
);

const RecordPaymentForm = ({
  workspaceId,
  invoiceId,
  currency,
  outstandingAmount,
  onClose,
}: Omit<RecordPaymentDialogProps, "open" | "onOpenChange"> & {
  onClose: () => void;
}) => {
  const t = useTranslations();
  const invalidate = useInvalidateInvoices();
  const paidOnLabelId = useId();

  const schema = v.pipe(
    v.strictObject({
      amountInputValue: v.string(),
      paidOn: v.pipe(v.string(), v.isoDate()),
      method: v.picklist(INVOICE_PAYMENT_METHODS),
      reference: v.pipe(
        v.string(),
        v.trim(),
        v.maxLength(INVOICE_PAYMENT_INPUT_LIMITS.referenceMaxChars),
      ),
    }),
    // The amount is typed in major units of the invoice's own currency.
    v.rawTransform(({ addIssue, dataset, NEVER }) => {
      const { amountInputValue, ...rest } = dataset.value;
      const check = checkPaymentAmount({
        input: amountInputValue,
        currency,
        outstandingAmount,
      });
      if (check.type !== "ok") {
        addIssue({
          message:
            check.type === "more_than_outstanding"
              ? t("billing.invoices.payments.amountTooHigh", {
                  amount: formatCurrencyAmount(outstandingAmount, currency),
                })
              : t("billing.amountMustBePositive"),
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
      return { ...rest, amount: check.amount };
    }),
  );

  const form = useForm(
    schemaFormOptions({
      schema,
      submitValues: "schema-output",
      defaultValues: {
        amountInputValue: majorUnitInput(outstandingAmount, currency),
        paidOn: localISODate(),
        method: DEFAULT_PAYMENT_METHOD,
        reference: "",
      },
      onSubmit: async ({ value }) => {
        const response = await invokeCapability(
          "invoices.payments.create",
          async (request) =>
            api
              .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
                invoiceId: toSafeId<"invoice">(invoiceId),
              })
              .payments.post(
                {
                  amount: value.amount,
                  paidOn: value.paidOn,
                  method: value.method,
                  reference: value.reference === "" ? null : value.reference,
                },
                request,
              ),
        );
        if (response.error) {
          notifyUserError(
            toAPIError(response.error),
            t("billing.failedToSave"),
          );
          return;
        }
        invalidate();
        onClose();
      },
    }),
  );

  const { formErrors, dirty } = useSelector(form.store, (s) => ({
    formErrors: toFormErrors(s.fieldMeta),
    dirty: !s.isDefaultValue,
  }));

  return (
    <div className="p-4">
      <Form
        className="flex flex-col gap-4"
        dirty={dirty}
        errors={formErrors}
        onDiscard={() => form.reset()}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          detached(form.handleSubmit(), "invoice-payments.submit");
        }}
      >
        <h2 className="text-sm font-semibold">
          {t("billing.invoices.payments.record")}
        </h2>
        <div className="flex gap-3">
          <form.Field name="amountInputValue">
            {(field) => (
              <Field className="flex-1" name={field.name}>
                <FieldLabel>
                  {t("billing.amount")} ({currency})
                </FieldLabel>
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  onBlur={() => {
                    field.handleBlur();
                    const amount = tryToMinorUnits({
                      amount: field.state.value,
                      currency,
                    });
                    if (amount !== null && amount > 0) {
                      field.handleChange(majorUnitInput(amount, currency));
                    }
                  }}
                  onChange={(event) =>
                    field.handleChange(event.currentTarget.value)
                  }
                  value={field.state.value}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="paidOn">
            {(field) => (
              <Field className="flex-1" name={field.name}>
                <FieldLabel id={paidOnLabelId}>
                  {t("billing.invoices.payments.paidOn")}
                </FieldLabel>
                <DatePickerPopover
                  labelledBy={paidOnLabelId}
                  onChange={(value) => field.handleChange(value ?? "")}
                  value={field.state.value}
                />
              </Field>
            )}
          </form.Field>
        </div>
        <form.Field name="method">
          {(field) => (
            <Field name={field.name}>
              <FieldLabel>{t("billing.invoices.payments.method")}</FieldLabel>
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
                  {INVOICE_PAYMENT_METHODS.map((method) => (
                    <SelectItem key={method} value={method}>
                      {t(`billing.invoices.payments.methods.${method}`)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
          )}
        </form.Field>
        <form.Field name="reference">
          {(field) => (
            <Field name={field.name}>
              <FieldLabel>{t("common.reference")}</FieldLabel>
              <Input
                maxLength={INVOICE_PAYMENT_INPUT_LIMITS.referenceMaxChars}
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
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} type="button" variant="ghost">
            {t("common.cancel")}
          </Button>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button loading={isSubmitting} type="submit">
                {t("billing.invoices.payments.record")}
              </Button>
            )}
          </form.Subscribe>
        </div>
      </Form>
    </div>
  );
};
