import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { parseDecimalToken } from "@stll/agent-input/numeric-token";
import {
  INVOICE_LINE_INPUT_LIMITS,
  INVOICE_LINE_QUANTITY_PATTERN,
} from "@stll/api-contract";
import { quantityText } from "@stll/invoicing";
import {
  currencyMinorUnitDigits,
  toMajorUnits,
  toMinorUnits,
  tryToMinorUnits,
} from "@stll/money";
import { Button } from "@stll/ui/button";
import { Field, FieldError } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import {
  allExpensesQueryRoot,
  allInvoicesQueryRoot,
  allTimeEntriesQueryRoot,
} from "@/lib/resource-query-roots.logic";
import { schemaFormOptions } from "@/lib/schema";
import type { invoiceByIdOptions } from "@/lib/workspaces/queries/invoices";

type InvoiceLine = Awaited<
  ReturnType<NonNullable<ReturnType<typeof invoiceByIdOptions>["queryFn"]>>
>["lines"][number];

type InvoiceLineEditorProps = {
  line: InvoiceLine;
  workspaceId: string;
  invoiceId: string;
  currency: string;
  editable: boolean;
};

export const InvoiceLineEditor = ({
  line,
  workspaceId,
  invoiceId,
  currency,
  editable,
}: InvoiceLineEditorProps) => {
  // The flat fee keeps its snapshotted amount and cannot be removed; the
  // server refuses both, and a flat-fee invoice holds no other line.
  const isFlatFeeLine = line.billingPurpose === "flat_fee";
  const t = useTranslations();
  const format = useFormatter();
  const queryClient = useQueryClient();
  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: allInvoicesQueryRoot() }),
      queryClient.invalidateQueries({ queryKey: allTimeEntriesQueryRoot() }),
      queryClient.invalidateQueries({ queryKey: allExpensesQueryRoot() }),
    ]);
  };
  const endpoint = api
    .invoices({ workspaceId })({ invoiceId })
    .lines({ lineId: line.id });
  const reset = useMutation({
    mutationFn: async () =>
      unwrapApiResponse(
        await invokeCapability("invoices.lines.update", async (request) =>
          endpoint.patch({ resetToRecorded: true }, request),
        ),
      ),
    onSuccess: invalidate,
    onError: (error) => notifyUserError(error, t("billing.failedToSave")),
  });
  const remove = useMutation({
    mutationFn: async () =>
      unwrapApiResponse(
        await invokeCapability("invoices.lines.delete", async (request) =>
          endpoint.delete({}, request),
        ),
      ),
    onSuccess: invalidate,
    onError: (error) => notifyUserError(error, t("billing.failedToSave")),
  });
  const form = useForm(
    schemaFormOptions({
      schema: v.strictObject({
        description: v.pipe(
          v.string(),
          v.minLength(INVOICE_LINE_INPUT_LIMITS.descriptionMinChars),
          v.maxLength(INVOICE_LINE_INPUT_LIMITS.descriptionMaxChars),
        ),
        quantity: v.pipe(
          v.string(),
          v.regex(new RegExp(INVOICE_LINE_QUANTITY_PATTERN, "u")),
        ),
        unitPrice: v.pipe(
          v.number(),
          v.minValue(INVOICE_LINE_INPUT_LIMITS.unitPriceMinMinor),
          v.check((amount) => tryToMinorUnits({ amount, currency }) !== null),
        ),
      }),
      defaultValues: {
        description: line.description,
        quantity: line.quantity,
        unitPrice: toMajorUnits({ amountCents: line.unitPrice, currency }),
      },
      submitValues: "schema-output",
      onSubmit: async ({ value }) => {
        const result = await invokeCapability(
          "invoices.lines.update",
          async (request) =>
            endpoint.patch(
              {
                description: value.description,
                ...(!isFlatFeeLine &&
                quantityText(value.quantity) !== quantityText(line.quantity)
                  ? { quantity: value.quantity }
                  : {}),
                ...(!isFlatFeeLine &&
                value.unitPrice !==
                  toMajorUnits({ amountCents: line.unitPrice, currency })
                  ? {
                      unitPriceMinor: toMinorUnits({
                        amount: value.unitPrice,
                        currency,
                      }),
                    }
                  : {}),
              },
              request,
            ),
        );
        if (result.error) {
          notifyUserError(result.error, t("billing.failedToSave"));
          return;
        }
        await invalidate();
      },
    }),
  );
  const edited =
    line.recordedDescription !== null &&
    (line.description !== line.recordedDescription ||
      quantityText(line.quantity) !== quantityText(line.recordedQuantity) ||
      line.unitPrice !== line.recordedUnitPrice ||
      Math.abs(line.netAmount) !==
        Math.abs(line.recordedNetAmount ?? line.netAmount));
  if (!editable) {
    return (
      <div className="grid gap-2 border-b p-4 last:border-0 sm:grid-cols-[1fr_7rem_9rem_9rem]">
        <p dir="auto">{line.description}</p>
        <p className="text-end tabular-nums">
          {format.number(
            parseDecimalToken(line.quantity, { sign: "unsigned" }).unwrap(
              "Stored invoice quantity must be a finite non-negative decimal",
            ),
          )}{" "}
          {line.unit}
        </p>
        <p className="text-end tabular-nums">
          {formatCurrencyAmount(line.unitPrice, currency)}
        </p>
        <p className="text-end tabular-nums">
          {formatCurrencyAmount(line.grossAmount, currency)}
        </p>
      </div>
    );
  }
  return (
    <div className="border-b p-4 last:border-0">
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          detached(form.handleSubmit(), "invoice-lines.save-override");
        }}
      >
        <div className="grid gap-2 sm:grid-cols-[1fr_7rem_9rem_9rem]">
          <form.Field name="description">
            {(field) => (
              <Field name={field.name}>
                <Input
                  aria-label={t("common.description")}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="quantity">
            {(field) => (
              <Field name={field.name}>
                <Input
                  aria-label={t("billing.invoices.lineOverrides.quantity")}
                  dir="ltr"
                  inputMode="decimal"
                  readOnly={isFlatFeeLine}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="unitPrice">
            {(field) => (
              <Field name={field.name}>
                <Input
                  aria-label={t("billing.invoiceComposer.rate")}
                  dir="ltr"
                  min={0}
                  step={10 ** -currencyMinorUnitDigits(currency)}
                  type="number"
                  readOnly={isFlatFeeLine}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) =>
                    field.handleChange(event.target.valueAsNumber)
                  }
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <p className="self-center text-end tabular-nums">
            {formatCurrencyAmount(line.grossAmount, currency)}
          </p>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          {edited && (
            <p className="text-muted-foreground me-auto text-xs" dir="auto">
              {t("billing.invoices.lineOverrides.editedRecorded", {
                description: line.recordedDescription ?? line.description,
                quantity: format.number(
                  parseDecimalToken(line.recordedQuantity ?? line.quantity, {
                    sign: "unsigned",
                  }).unwrap(
                    "Recorded invoice quantity must be a finite non-negative decimal",
                  ),
                ),
                rate: formatCurrencyAmount(
                  line.recordedUnitPrice ?? line.unitPrice,
                  currency,
                ),
              })}
            </p>
          )}
          {!isFlatFeeLine && (
            <Button
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("common.remove")}
            </Button>
          )}
          {edited && (
            <Button
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
              size="sm"
              type="button"
              variant="ghost"
            >
              {t("billing.invoices.lineOverrides.resetRecorded")}
            </Button>
          )}
          <form.Subscribe
            selector={(state) => ({
              dirty: !state.isDefaultValue,
              pending: state.isSubmitting,
            })}
          >
            {({ dirty, pending }) =>
              dirty && (
                <Button loading={pending} size="sm" type="submit">
                  {t("common.save")}
                </Button>
              )
            }
          </form.Subscribe>
        </div>
      </Form>
    </div>
  );
};
