import { Suspense, useState } from "react";

import { applyMarkupCents, prorateHourlyCents } from "@stll/money";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@stll/ui/components/alert-dialog";
import { Button } from "@stll/ui/components/button";
import { DatePickerPopover } from "@stll/ui/components/date-picker-popover";
import { Dialog, DialogPopup } from "@stll/ui/components/dialog";
import { Field, FieldError } from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import { Input } from "@stll/ui/components/input";
import { Label } from "@stll/ui/components/label";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { useForm, useStore } from "@tanstack/react-form";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  EditIcon,
  SendIcon,
  Trash2Icon,
  UndoIcon,
  XCircleIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { usePermissions } from "@/hooks/use-permissions";
import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import {
  requiredTrimmedStringSchema,
  toFormErrors,
  trimmedStringSchema,
} from "@/lib/schema";
import { formatCurrencyAmount } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/format-currency";
import { InvoiceStatusBadge } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-status-badge";
import {
  invoiceByIdOptions,
  invoicesKeys,
} from "@/routes/_protected.workspaces/$workspaceId/-queries/invoices";
import type { InvoiceStatus } from "@/routes/_protected.workspaces/$workspaceId/-queries/invoices";
import { timeEntriesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/time-entries";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/invoices/$invoiceId",
)({
  component: InvoiceDetailPage,
});

function InvoiceDetailPage() {
  const t = useTranslations();
  const { workspaceId, invoiceId } = Route.useParams({
    select: (p) => ({
      workspaceId: p.workspaceId,
      invoiceId: p.invoiceId,
    }),
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Link params={{ workspaceId }} to="/workspaces/$workspaceId/invoices">
          <Button size="icon" variant="ghost">
            <ArrowLeftIcon className="size-4" />
          </Button>
        </Link>
        <h1 className="text-sm font-medium">
          {t("billing.invoices.invoiceDetail")}
        </h1>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <Suspense
          fallback={
            <div className="text-muted-foreground py-8 text-center text-sm">
              {t("billing.loading")}
            </div>
          }
        >
          <InvoiceDetail invoiceId={invoiceId} workspaceId={workspaceId} />
        </Suspense>
      </div>
    </div>
  );
}

const showErrorToast = (title: string) => {
  stellaToast.add({ type: "error", title });
};

const InvoiceDetail = ({
  workspaceId,
  invoiceId,
}: {
  workspaceId: string;
  invoiceId: string;
}) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);

  const { data: invoice } = useSuspenseQuery(
    invoiceByIdOptions(workspaceId, invoiceId),
  );

  const invalidateAll = () => {
    // eslint-disable-next-line typescript/no-floating-promises
    queryClient.invalidateQueries({
      queryKey: invoicesKeys.all(workspaceId),
    });
    // eslint-disable-next-line typescript/no-floating-promises
    queryClient.invalidateQueries({
      queryKey: timeEntriesKeys.all(workspaceId),
    });
  };

  type TransitionAction =
    | "finalize"
    | "send"
    | "mark_paid"
    | "void"
    | "revert_to_draft";

  const transitionMutation = useMutation({
    mutationFn: async (action: TransitionAction) => {
      const response = await api
        .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          invoiceId: toSafeId<"invoice">(invoiceId),
        })
        .transition.post({
          action,
          queryKey: invoicesKeys.all(workspaceId),
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      invalidateAll();
    },
    onError: () => {
      showErrorToast(t("common.somethingWentWrong"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await api
        .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          invoiceId: toSafeId<"invoice">(invoiceId),
        })
        .delete({
          queryKey: invoicesKeys.all(workspaceId),
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: async () => {
      invalidateAll();
      await navigate({
        to: "/workspaces/$workspaceId/invoices",
        params: { workspaceId },
      });
    },
    onError: () => {
      showErrorToast(t("common.somethingWentWrong"));
    },
  });

  const removeEntryMutation = useMutation({
    mutationFn: async (timeEntryId: string) => {
      const response = await api
        .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          invoiceId: toSafeId<"invoice">(invoiceId),
        })
        .entries.delete({
          timeEntryIds: [toSafeId<"timeEntry">(timeEntryId)],
          queryKey: invoicesKeys.all(workspaceId),
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      invalidateAll();
    },
    onError: () => {
      showErrorToast(t("common.somethingWentWrong"));
    },
  });

  const removeExpenseMutation = useMutation({
    mutationFn: async (expenseId: string) => {
      const response = await api
        .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          invoiceId: toSafeId<"invoice">(invoiceId),
        })
        .entries.delete({
          expenseIds: [toSafeId<"expense">(expenseId)],
          queryKey: invoicesKeys.all(workspaceId),
        });
      if (response.error) {
        throw toAPIError(response.error);
      }
      return response.data;
    },
    onSuccess: () => {
      invalidateAll();
    },
    onError: () => {
      showErrorToast(t("common.somethingWentWrong"));
    },
  });

  const invoiceStatus: InvoiceStatus = invoice.status;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">{invoice.invoiceNumber}</h2>
            <InvoiceStatusBadge status={invoiceStatus} />
          </div>
          {invoice.reference && (
            <p className="text-muted-foreground text-sm">{invoice.reference}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <InvoiceActions
            invoiceStatus={invoiceStatus}
            onDelete={() => deleteMutation.mutate()}
            onEdit={() => setEditOpen(true)}
            onTransition={(action) => transitionMutation.mutate(action)}
          />
        </div>
      </div>

      {/* Info grid */}
      <div className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-4">
        <InfoCell
          label={t("billing.invoices.invoiceDate")}
          value={invoice.invoiceDate}
        />
        <InfoCell
          label={t("billing.invoices.dueDate")}
          value={invoice.dueDate ?? "—"}
        />
        <InfoCell
          label={t("billing.invoices.totalAmount")}
          value={formatCurrencyAmount(invoice.totalAmount, invoice.currency)}
        />
        {invoice.paidAt && (
          <InfoCell
            label={t("billing.invoices.paidAt")}
            value={new Date(invoice.paidAt).toLocaleDateString()}
          />
        )}
      </div>

      {/* Notes */}
      {invoice.notes && (
        <div className="rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs font-medium">
            {t("common.notes")}
          </p>
          <p className="text-sm whitespace-pre-wrap">{invoice.notes}</p>
        </div>
      )}

      {/* Time entries */}
      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-sm font-medium">
            {t("billing.invoices.linkedTimeEntries")}
          </h3>
          <span className="text-muted-foreground text-xs">
            {t("billing.invoices.totalEntries", {
              count: invoice.timeEntries.length,
            })}
          </span>
        </div>
        {invoice.timeEntries.length === 0 ? (
          <div className="text-muted-foreground py-6 text-center text-sm">
            {t("billing.invoices.noEntries")}
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-start">
                  <th className="px-4 py-2 font-medium">
                    {t("common.matter")}
                  </th>
                  <th className="px-4 py-2 font-medium">{t("common.date")}</th>
                  <th className="px-4 py-2 font-medium">
                    {t("billing.narrative")}
                  </th>
                  <th className="px-4 py-2 text-end font-medium">
                    {t("billing.hours")}
                  </th>
                  <th className="px-4 py-2 text-end font-medium">
                    {t("billing.amount")}
                  </th>
                  {invoiceStatus === "draft" && (
                    <th className="w-10 px-4 py-2" />
                  )}
                </tr>
              </thead>
              <tbody>
                {invoice.timeEntries.map((entry) => (
                  <tr className="border-b last:border-0" key={entry.id}>
                    <td className="px-4 py-2">{entry.matter?.name ?? "—"}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {entry.dateWorked}
                    </td>
                    <td className="max-w-xs truncate px-4 py-2">
                      {entry.invoiceNarrative ?? entry.narrative}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">
                      {(entry.billedMinutes / 60).toFixed(1)}h
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">
                      {formatCurrencyAmount(
                        prorateHourlyCents({
                          billedMinutes: entry.billedMinutes,
                          hourlyRateCents: entry.rateAtEntry,
                        }),
                        entry.currency,
                      )}
                    </td>
                    {invoiceStatus === "draft" && (
                      <td className="px-4 py-2">
                        <Button
                          className="size-6"
                          onClick={() => removeEntryMutation.mutate(entry.id)}
                          size="icon"
                          variant="ghost"
                        >
                          <XCircleIcon className="text-muted-foreground size-3.5" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Expenses */}
      {invoice.expenses.length > 0 && (
        <div className="rounded-lg border">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h3 className="text-sm font-medium">
              {t("billing.invoices.linkedExpenses")}
            </h3>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-start">
                  <th className="px-4 py-2 font-medium">
                    {t("common.matter")}
                  </th>
                  <th className="px-4 py-2 font-medium">{t("common.date")}</th>
                  <th className="px-4 py-2 font-medium">
                    {t("common.description")}
                  </th>
                  <th className="px-4 py-2 text-end font-medium">
                    {t("billing.amount")}
                  </th>
                  {invoiceStatus === "draft" && (
                    <th className="w-10 px-4 py-2" />
                  )}
                </tr>
              </thead>
              <tbody>
                {invoice.expenses.map((expense) => (
                  <tr className="border-b last:border-0" key={expense.id}>
                    <td className="px-4 py-2">{expense.matter?.name ?? "—"}</td>
                    <td className="px-4 py-2 tabular-nums">
                      {expense.dateIncurred}
                    </td>
                    <td className="max-w-xs truncate px-4 py-2">
                      {expense.invoiceDescription ?? expense.description}
                    </td>
                    <td className="px-4 py-2 text-end tabular-nums">
                      {formatCurrencyAmount(
                        applyMarkupCents({
                          amountCents: expense.amount,
                          markupPercent: expense.markup,
                        }),
                        expense.currency,
                      )}
                    </td>
                    {invoiceStatus === "draft" && (
                      <td className="px-4 py-2">
                        <Button
                          className="size-6"
                          onClick={() =>
                            removeExpenseMutation.mutate(expense.id)
                          }
                          size="icon"
                          variant="ghost"
                        >
                          <XCircleIcon className="text-muted-foreground size-3.5" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Edit dialog */}
      <Dialog onOpenChange={setEditOpen} open={editOpen}>
        <DialogPopup className="max-w-md">
          <EditInvoiceForm
            currency={invoice.currency}
            dueDate={invoice.dueDate ?? ""}
            invoiceDate={invoice.invoiceDate}
            invoiceId={invoiceId}
            invoiceNumber={invoice.invoiceNumber}
            notes={invoice.notes ?? ""}
            onClose={() => setEditOpen(false)}
            reference={invoice.reference ?? ""}
            workspaceId={workspaceId}
          />
        </DialogPopup>
      </Dialog>
    </div>
  );
};

const InfoCell = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="text-muted-foreground text-xs">{label}</p>
    <p className="mt-0.5 text-sm font-medium tabular-nums">{value}</p>
  </div>
);

const InvoiceActions = ({
  invoiceStatus,
  onTransition,
  onEdit,
  onDelete,
}: {
  invoiceStatus: InvoiceStatus;
  onTransition: (
    action: "finalize" | "send" | "mark_paid" | "void" | "revert_to_draft",
  ) => void;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  const t = useTranslations("billing.invoices");
  const rootT = useTranslations();
  const canUpdateInvoice = usePermissions({ invoice: ["update"] });
  const canDeleteInvoice = usePermissions({ invoice: ["delete"] });

  switch (invoiceStatus) {
    case "draft":
      return (
        <>
          {canUpdateInvoice && (
            <Button onClick={onEdit} size="sm" variant="outline">
              <EditIcon className="size-3.5" />
              {t("editInvoice")}
            </Button>
          )}
          {canUpdateInvoice && (
            <Button
              onClick={() => onTransition("finalize")}
              size="sm"
              variant="outline"
            >
              <CheckIcon className="size-3.5" />
              {t("finalize")}
            </Button>
          )}
          {canDeleteInvoice && (
            <ConfirmAction
              description={t("confirmDelete")}
              onConfirm={onDelete}
            >
              <Button size="sm" variant="destructive">
                <Trash2Icon className="size-3.5" />
                {rootT("common.delete")}
              </Button>
            </ConfirmAction>
          )}
        </>
      );
    case "finalized":
      return (
        <>
          {canUpdateInvoice && (
            <Button
              onClick={() => onTransition("send")}
              size="sm"
              variant="outline"
            >
              <SendIcon className="size-3.5" />
              {t("send")}
            </Button>
          )}
          {canUpdateInvoice && (
            <Button
              onClick={() => onTransition("revert_to_draft")}
              size="sm"
              variant="ghost"
            >
              <UndoIcon className="size-3.5" />
              {rootT("billing.revertToDraft")}
            </Button>
          )}
          {canUpdateInvoice && (
            <ConfirmAction
              description={t("confirmVoid")}
              onConfirm={() => onTransition("void")}
            >
              <Button size="sm" variant="destructive">
                <XCircleIcon className="size-3.5" />
                {t("void")}
              </Button>
            </ConfirmAction>
          )}
        </>
      );
    case "sent":
      return (
        <>
          {canUpdateInvoice && (
            <Button
              onClick={() => onTransition("mark_paid")}
              size="sm"
              variant="outline"
            >
              <CheckIcon className="size-3.5" />
              {t("markPaid")}
            </Button>
          )}
          {canUpdateInvoice && (
            <ConfirmAction
              description={t("confirmVoid")}
              onConfirm={() => onTransition("void")}
            >
              <Button size="sm" variant="destructive">
                <XCircleIcon className="size-3.5" />
                {t("void")}
              </Button>
            </ConfirmAction>
          )}
        </>
      );
    case "paid":
      return canUpdateInvoice ? (
        <ConfirmAction
          description={t("confirmVoid")}
          onConfirm={() => onTransition("void")}
        >
          <Button size="sm" variant="destructive">
            <XCircleIcon className="size-3.5" />
            {t("void")}
          </Button>
        </ConfirmAction>
      ) : null;
    case "void":
      return null;
    default:
      return null;
  }
};

const ConfirmAction = ({
  children,
  description,
  onConfirm,
}: {
  children: React.ReactElement;
  description: string;
  onConfirm: () => void;
}) => {
  const t = useTranslations("common");

  return (
    <AlertDialog>
      <AlertDialogTrigger render={children} />
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("confirmAction")}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>
            {t("cancel")}
          </AlertDialogClose>
          <AlertDialogClose
            render={<Button onClick={onConfirm} variant="destructive" />}
          >
            {t("confirm")}
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
};

const editInvoiceSchema = v.strictObject({
  invoiceNumber: v.pipe(
    requiredTrimmedStringSchema("Required"),
    v.maxLength(64),
  ),
  invoiceDate: v.pipe(v.string(), v.isoDate()),
  dueDate: v.union([v.literal(""), v.pipe(v.string(), v.isoDate())]),
  reference: trimmedStringSchema(),
  currency: v.pipe(trimmedStringSchema(), v.toUpperCase(), v.length(3)),
  notes: trimmedStringSchema(),
});

const EditInvoiceForm = ({
  workspaceId,
  invoiceId,
  invoiceNumber: initialNumber,
  invoiceDate: initialDate,
  dueDate: initialDueDate,
  reference: initialReference,
  currency: initialCurrency,
  notes: initialNotes,
  onClose,
}: {
  workspaceId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  reference: string;
  currency: string;
  notes: string;
  onClose: () => void;
}) => {
  const t = useTranslations();
  const queryClient = useQueryClient();

  const form = useForm({
    defaultValues: {
      invoiceNumber: initialNumber,
      invoiceDate: initialDate,
      dueDate: initialDueDate,
      reference: initialReference,
      currency: initialCurrency,
      notes: initialNotes,
    },
    validators: {
      onDynamic: editInvoiceSchema,
    },
    onSubmit: async ({ value }) => {
      const parseResult = v.safeParse(editInvoiceSchema, value);
      if (!parseResult.success) {
        return;
      }
      const parsedValue = parseResult.output;
      const response = await api
        .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          invoiceId: toSafeId<"invoice">(invoiceId),
        })
        .patch({
          invoiceNumber: parsedValue.invoiceNumber,
          invoiceDate: parsedValue.invoiceDate,
          dueDate: parsedValue.dueDate || null,
          reference: parsedValue.reference || null,
          currency: parsedValue.currency,
          notes: parsedValue.notes || null,
          queryKey: invoicesKeys.all(workspaceId),
        });
      if (response.error) {
        showErrorToast(t("billing.failedToSave"));
        return;
      }
      // eslint-disable-next-line typescript/no-floating-promises
      queryClient.invalidateQueries({
        queryKey: invoicesKeys.all(workspaceId),
      });
      onClose();
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

  return (
    <Form
      className="flex flex-col gap-4 p-4"
      errors={formErrors}
      onSubmit={(e) => {
        e.preventDefault();
        // eslint-disable-next-line typescript/no-floating-promises
        form.handleSubmit();
      }}
    >
      <h2 className="text-sm font-semibold">
        {t("billing.invoices.editInvoice")}
      </h2>
      <form.Field name="invoiceNumber">
        {(field) => (
          <Field name={field.name}>
            <Label>{t("billing.invoices.invoiceNumber")}</Label>
            <Input
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              value={field.state.value}
            />
            <FieldError />
          </Field>
        )}
      </form.Field>
      <div className="grid grid-cols-2 gap-3">
        <form.Field name="invoiceDate">
          {(field) => (
            <Field name={field.name}>
              <Label>{t("billing.invoices.invoiceDate")}</Label>
              <DatePickerPopover
                onChange={(val) => field.handleChange(val ?? "")}
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>
        <form.Field name="dueDate">
          {(field) => (
            <Field name={field.name}>
              <Label>{t("billing.invoices.dueDate")}</Label>
              <DatePickerPopover
                onChange={(val) => field.handleChange(val ?? "")}
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>
      </div>
      <form.Field name="reference">
        {(field) => (
          <Field name={field.name}>
            <Label>{t("common.reference")}</Label>
            <Input
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              value={field.state.value}
            />
            <FieldError />
          </Field>
        )}
      </form.Field>
      <form.Field name="currency">
        {(field) => (
          <Field name={field.name}>
            <Label>{t("common.currency")}</Label>
            <Input
              maxLength={3}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value.toUpperCase())}
              value={field.state.value}
            />
            <FieldError />
          </Field>
        )}
      </form.Field>
      <form.Field name="notes">
        {(field) => (
          <Field name={field.name}>
            <Label>{t("common.notes")}</Label>
            <Textarea
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              rows={3}
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
              {t("common.save")}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </Form>
  );
};
