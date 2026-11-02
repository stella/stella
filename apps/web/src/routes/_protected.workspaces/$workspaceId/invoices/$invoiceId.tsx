import { Suspense, useState } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { applyMarkupCents, timeEntryAmount } from "@stll/money";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Dialog, DialogPopup } from "@stll/ui/dialog";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Field, FieldError } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import {
  ArrowLeftIcon,
  CheckIcon,
  EditIcon,
  SendIcon,
  Trash2Icon,
  UndoIcon,
  XCircleIcon,
} from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { MatterIcon } from "@stll/ui/matter-icon";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { Textarea } from "@stll/ui/textarea";
import { cn } from "@stll/ui/utils";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import {
  MEDIUM_DATE,
  plainDateEpoch,
} from "@/components/billing/format-plain-date";
import { InvoicePdfDownloadButton } from "@/components/billing/invoice-pdf-download-button";
import { DatePickerPopover } from "@/components/date-picker-popover";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError, unwrapApiResponse } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { ensureRouteQueryData } from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
import {
  schemaFormOptions,
  toFormErrors,
  trimmedStringSchema,
} from "@/lib/schema";
import {
  invoiceByIdOptions,
  invoicesKeys,
} from "@/lib/workspaces/queries/invoices";
import type { InvoiceStatus } from "@/lib/workspaces/queries/invoices";
import { timeEntriesKeys } from "@/lib/workspaces/queries/time-entries";
import { ConfirmAction } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/confirm-action";
import { InvoiceExportMenu } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-export-menu";
import { InvoiceLineEditor } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-line-editor";
import {
  InvoicePaymentsSection,
  RecordPaymentDialog,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-payments";
import {
  invoiceTakesPayments,
  isPartiallyPaid,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-payments.logic";
import { InvoiceStatusBadge } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/invoice-status-badge";

export const Route = createFileRoute(
  "/_protected/workspaces/$workspaceId/invoices/$invoiceId",
)({
  component: InvoiceDetailPage,
  loader: async ({ context, params }) => {
    // Prime the invoice query the detail view suspends on so the fetch starts
    // during navigation instead of after the component mounts and suspends.
    await ensureRouteQueryData(
      context.queryClient,
      invoiceByIdOptions(params.workspaceId, params.invoiceId),
    );
  },
  remountDeps: ({ params }) => [params.workspaceId, params.invoiceId],
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
          <Button aria-label={t("common.back")} size="icon" variant="ghost">
            <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
          </Button>
        </Link>
        <h1 className="text-sm font-medium">
          {t("billing.invoices.invoiceDetail")}
        </h1>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <Suspense fallback={<InvoiceDetailSkeleton />}>
          <InvoiceDetail invoiceId={invoiceId} workspaceId={workspaceId} />
        </Suspense>
      </div>
    </div>
  );
}

// Stable keys so skeleton rows/cells never fall back to array-index keys.
const INFO_CELL_KEYS = ["a", "b", "c", "d"] as const;
const ENTRY_ROW_KEYS = ["a", "b", "c", "d", "e"] as const;
// Plain `Table` (not TanStack) with: context, date, narrative, hours, amount.
const ENTRY_COLUMN_KEYS = [
  "context",
  "date",
  "narrative",
  "hours",
  "amount",
] as const;
const ENTRY_END_ALIGNED_COLUMNS = Object.freeze(["hours", "amount"]);

// Mirrors the real InvoiceDetail layout (header row, info grid, time-entries
// table) so only values fill in when the query resolves; the page does not jump.
const InvoiceDetailSkeleton = () => (
  <div className="mx-auto flex max-w-4xl flex-col gap-6">
    {/* Header */}
    <div className="flex items-start justify-between">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-5 w-16 rounded-md" />
        </div>
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-8 w-24 rounded-md" />
        <Skeleton className="h-8 w-24 rounded-md" />
      </div>
    </div>

    {/* Info grid */}
    <div className="grid grid-cols-2 gap-4 rounded-lg border p-4 sm:grid-cols-4">
      {INFO_CELL_KEYS.map((key) => (
        <div key={key}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-1.5 h-4 w-24" />
        </div>
      ))}
    </div>

    {/* Time entries */}
    <div className="rounded-lg border">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="overflow-auto">
        <Table inset="card" scroll="parent">
          <TableHeader>
            <TableRow>
              {ENTRY_COLUMN_KEYS.map((column) => (
                <TableHead key={column}>
                  <Skeleton
                    className={cn(
                      "h-3 w-16",
                      ENTRY_END_ALIGNED_COLUMNS.includes(column) && "ms-auto",
                    )}
                  />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {ENTRY_ROW_KEYS.map((rowKey) => (
              <TableRow key={rowKey}>
                {ENTRY_COLUMN_KEYS.map((column) => (
                  <TableCell key={column}>
                    <Skeleton
                      className={cn(
                        "h-4 w-3/5",
                        ENTRY_END_ALIGNED_COLUMNS.includes(column) &&
                          "ms-auto w-12",
                      )}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  </div>
);

const showErrorToast = (error: unknown, title: string) => {
  notifyUserError(error, title);
};

const InvoiceDetail = ({
  workspaceId,
  invoiceId,
}: {
  workspaceId: string;
  invoiceId: string;
}) => {
  const t = useTranslations();
  const format = useFormatter();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const canUpdateInvoice = usePermissions({ invoice: ["update"] });

  const { data: invoice } = useSuspenseQuery(
    invoiceByIdOptions(workspaceId, invoiceId),
  );

  const invalidateAll = () => {
    detached(
      queryClient.invalidateQueries({
        queryKey: invoicesKeys.all(workspaceId),
      }),
      "invoices.invalidate",
    );
    detached(
      queryClient.invalidateQueries({
        queryKey: timeEntriesKeys.all(workspaceId),
      }),
      "invoices.invalidate",
    );
  };

  type TransitionAction = "finalize" | "send" | "void" | "revert_to_draft";

  const transitionMutation = useMutation({
    mutationFn: async (action: TransitionAction) => {
      const response = await api
        .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          invoiceId: toSafeId<"invoice">(invoiceId),
        })
        .transition.post({
          action,
        });
      return unwrapApiResponse(response);
    },
    onSuccess: () => {
      invalidateAll();
    },
    onError: (error) => {
      showErrorToast(error, t("common.somethingWentWrong"));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await api
        .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
          invoiceId: toSafeId<"invoice">(invoiceId),
        })
        .delete({});
      return unwrapApiResponse(response);
    },
    onSuccess: async () => {
      invalidateAll();
      await navigate({
        to: "/workspaces/$workspaceId/invoices",
        params: { workspaceId },
      });
    },
    onError: (error) => {
      showErrorToast(error, t("common.somethingWentWrong"));
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
        });
      return unwrapApiResponse(response);
    },
    onSuccess: () => {
      invalidateAll();
    },
    onError: (error) => {
      showErrorToast(error, t("common.somethingWentWrong"));
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
        });
      return unwrapApiResponse(response);
    },
    onSuccess: () => {
      invalidateAll();
    },
    onError: (error) => {
      showErrorToast(error, t("common.somethingWentWrong"));
    },
  });

  const matterGroups = new Map<string, typeof invoice.lines>();
  for (const line of invoice.lines) {
    const group = matterGroups.get(line.workspaceId);
    if (group) {
      group.push(line);
    } else {
      matterGroups.set(line.workspaceId, [line]);
    }
  }

  const invoiceStatus: InvoiceStatus = invoice.status;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold">
              {invoice.invoiceNumber ?? t("billing.invoices.statuses.draft")}
            </h2>
            <InvoiceStatusBadge
              partiallyPaid={isPartiallyPaid(invoice)}
              status={invoiceStatus}
            />
          </div>
          {(invoiceTakesPayments(invoiceStatus) ||
            invoiceStatus === "paid") && (
            <p className="text-muted-foreground text-sm tabular-nums">
              {t("billing.invoices.payments.outstandingAmount", {
                amount: formatCurrencyAmount(
                  invoice.outstandingAmount,
                  invoice.currency,
                ),
              })}
            </p>
          )}
          {invoice.reference && (
            <p className="text-muted-foreground text-sm">{invoice.reference}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <InvoicePdfDownloadButton
            invoiceId={invoiceId}
            workspaceId={workspaceId}
          />
          {invoice.status !== "draft" && invoice.status !== "void" && (
            <InvoiceExportMenu
              invoiceId={invoiceId}
              workspaceId={workspaceId}
            />
          )}
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
          value={format.dateTime(
            plainDateEpoch(invoice.invoiceDate),
            MEDIUM_DATE,
          )}
        />
        <InfoCell
          label={t("billing.invoices.dueDate")}
          value={
            invoice.dueDate === null
              ? "—"
              : format.dateTime(plainDateEpoch(invoice.dueDate), MEDIUM_DATE)
          }
        />
        <InfoCell
          label={t("billing.invoices.totalAmount")}
          value={formatCurrencyAmount(invoice.totalAmount, invoice.currency)}
        />
        {invoice.paidAt && (
          <InfoCell
            label={t("billing.invoices.paidAt")}
            value={format.dateTime(
              Temporal.Instant.from(invoice.paidAt).epochMilliseconds,
            )}
          />
        )}
      </div>

      {(invoiceTakesPayments(invoiceStatus) ||
        invoiceStatus === "paid" ||
        invoice.payments.length > 0) && (
        <InvoicePaymentsSection
          canUpdate={canUpdateInvoice}
          invoice={invoice}
          invoiceId={invoiceId}
          onRecord={() => setRecordPaymentOpen(true)}
          workspaceId={workspaceId}
        />
      )}
      <RecordPaymentDialog
        currency={invoice.currency}
        invoiceId={invoiceId}
        onOpenChange={setRecordPaymentOpen}
        open={recordPaymentOpen}
        outstandingAmount={invoice.outstandingAmount}
        workspaceId={workspaceId}
      />

      {/* Notes */}
      {invoice.notes && (
        <div className="rounded-lg border p-4">
          <p className="text-muted-foreground mb-1 text-xs font-medium">
            {t("common.notes")}
          </p>
          <p className="text-sm whitespace-pre-wrap">{invoice.notes}</p>
        </div>
      )}

      {invoice.lines.length > 0 && (
        <div className="flex flex-col gap-4">
          {invoice.workspaceId === null && (
            <p className="text-muted-foreground text-sm">
              {t("billing.clientComposer.visibility")}
            </p>
          )}
          {[...matterGroups].map(([matterId, lines]) => {
            const matter = lines.at(0)?.workspace;
            const amount = lines.reduce(
              (sum, line) => sum + line.grossAmount,
              0,
            );
            const share =
              invoice.totalAmount === 0 ? 0 : amount / invoice.totalAmount;
            return (
              <section className="rounded-lg border" key={matterId}>
                <div className="flex items-center gap-2 border-b px-4 py-3">
                  <MatterIcon
                    className="size-5"
                    matter={{ id: matterId, color: matter?.color ?? null }}
                  />
                  <h3 className="text-sm font-medium" dir="auto">
                    {matter?.name ?? t("common.matter")}
                  </h3>
                </div>
                <div className="text-muted-foreground hidden gap-2 px-4 pt-3 text-xs sm:grid sm:grid-cols-[1fr_7rem_9rem_9rem]">
                  <span>{t("common.description")}</span>
                  <span>{t("billing.invoices.lineOverrides.quantity")}</span>
                  <span>{t("billing.invoiceComposer.rate")}</span>
                  <span className="text-end">{t("billing.amount")}</span>
                </div>
                {lines.map((line) => (
                  <InvoiceLineEditor
                    key={`${line.id}:${line.description}:${line.quantity}:${line.unitPrice}`}
                    line={line}
                    workspaceId={line.workspaceId}
                    invoiceId={invoiceId}
                    currency={invoice.currency}
                    editable={
                      invoice.status === "draft" &&
                      invoice.finalizedAt === null &&
                      canUpdateInvoice
                    }
                  />
                ))}
                <div className="flex flex-col gap-2 px-4 py-3">
                  <p className="text-muted-foreground text-end text-xs tabular-nums">
                    {t("billing.clientComposer.matterSubtotal", {
                      amount: formatCurrencyAmount(amount, invoice.currency),
                      share: format.number(share, {
                        style: "percent",
                        maximumFractionDigits: 1,
                      }),
                    })}
                  </p>
                  <div className="bg-muted h-1 overflow-hidden rounded-full">
                    <div
                      className="bg-foreground h-full"
                      style={{
                        width: `${Math.max(0, Math.min(100, share * 100))}%`,
                      }}
                    />
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {invoice.lines.length === 0 && (
        <>
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
                <Table inset="card" scroll="parent">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("chat.composerMenu.context")}</TableHead>
                      <TableHead>{t("common.date")}</TableHead>
                      <TableHead>{t("billing.narrative")}</TableHead>
                      <TableHead align="end">{t("billing.hours")}</TableHead>
                      <TableHead align="end">{t("billing.amount")}</TableHead>
                      {invoiceStatus === "draft" && (
                        <TableHead className="w-10" />
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoice.timeEntries.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="whitespace-normal">
                          <span className="leading-5">
                            {entry.workItem?.name ?? t("common.matter")}
                          </span>
                        </TableCell>
                        <TableCell align="start" numeric>
                          {format.dateTime(
                            plainDateEpoch(entry.dateWorked),
                            MEDIUM_DATE,
                          )}
                        </TableCell>
                        <TableCell className="max-w-xs" truncate>
                          {entry.invoiceNarrative ?? entry.narrative}
                        </TableCell>
                        <TableCell align="end" numeric>
                          {format.number(entry.billedMinutes / 60, {
                            style: "unit",
                            unit: "hour",
                            unitDisplay: "short",
                            minimumFractionDigits: 1,
                            maximumFractionDigits: 1,
                          })}
                        </TableCell>
                        <TableCell align="end" numeric>
                          {formatCurrencyAmount(
                            timeEntryAmount(entry),
                            entry.currency,
                          )}
                        </TableCell>
                        {invoiceStatus === "draft" && (
                          <TableCell>
                            <Button
                              aria-label={t("common.remove")}
                              className="size-6"
                              onClick={() =>
                                removeEntryMutation.mutate(entry.id)
                              }
                              size="icon"
                              variant="ghost"
                            >
                              <XCircleIcon className="text-muted-foreground size-3.5" />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
                <Table inset="card" scroll="parent">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("common.matter")}</TableHead>
                      <TableHead>{t("common.date")}</TableHead>
                      <TableHead>{t("common.description")}</TableHead>
                      <TableHead align="end">{t("billing.amount")}</TableHead>
                      {invoiceStatus === "draft" && (
                        <TableHead className="w-10" />
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {invoice.expenses.map((expense) => (
                      <TableRow key={expense.id}>
                        <TableCell className="whitespace-normal">
                          <span className="leading-5">
                            {expense.matter?.name ?? "—"}
                          </span>
                        </TableCell>
                        <TableCell align="start" numeric>
                          {format.dateTime(
                            plainDateEpoch(expense.dateIncurred),
                            MEDIUM_DATE,
                          )}
                        </TableCell>
                        <TableCell className="max-w-xs" truncate>
                          {expense.invoiceDescription ?? expense.description}
                        </TableCell>
                        <TableCell align="end" numeric>
                          {formatCurrencyAmount(
                            applyMarkupCents({
                              amountCents: expense.amount,
                              markupPercent: expense.markup,
                            }),
                            expense.currency,
                          )}
                        </TableCell>
                        {invoiceStatus === "draft" && (
                          <TableCell>
                            <Button
                              aria-label={t("common.remove")}
                              className="size-6"
                              onClick={() =>
                                removeExpenseMutation.mutate(expense.id)
                              }
                              size="icon"
                              variant="ghost"
                            >
                              <XCircleIcon className="text-muted-foreground size-3.5" />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Edit dialog */}
      <Dialog onOpenChange={setEditOpen} open={editOpen}>
        <DialogPopup className="max-w-md">
          <EditInvoiceForm
            currency={invoice.currency}
            dueDate={invoice.dueDate ?? ""}
            invoiceDate={invoice.invoiceDate}
            invoiceId={invoiceId}
            invoiceNumber={invoice.invoiceNumber ?? ""}
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
    action: "finalize" | "send" | "void" | "revert_to_draft",
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
    // Payments are recorded in the payments section; paid follows from them.
    case "sent":
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

const editInvoiceSchema = v.strictObject({
  invoiceNumber: v.pipe(trimmedStringSchema(), v.maxLength(64)),
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

  const form = useForm(
    schemaFormOptions({
      schema: editInvoiceSchema,
      defaultValues: {
        invoiceNumber: initialNumber,
        invoiceDate: initialDate,
        dueDate: initialDueDate,
        reference: initialReference,
        currency: initialCurrency,
        notes: initialNotes,
      },
      submitValues: "schema-output",
      onSubmit: async ({ value }) => {
        const response = await api
          .invoices({ workspaceId: toSafeId<"workspace">(workspaceId) })({
            invoiceId: toSafeId<"invoice">(invoiceId),
          })
          .patch({
            invoiceNumber: value.invoiceNumber || null,
            invoiceDate: value.invoiceDate,
            dueDate: value.dueDate || null,
            reference: value.reference || null,
            currency: value.currency,
            notes: value.notes || null,
          });
        if (response.error) {
          showErrorToast(toAPIError(response.error), t("billing.failedToSave"));
          return;
        }
        detached(
          queryClient.invalidateQueries({
            queryKey: invoicesKeys.all(workspaceId),
          }),
          "invoices.invalidate",
        );
        onClose();
      },
    }),
  );

  const { formErrors, dirty } = useSelector(form.store, (s) => ({
    formErrors: toFormErrors(s.fieldMeta),
    dirty: !s.isDefaultValue,
  }));

  return (
    <Form
      dirty={dirty}
      onDiscard={() => form.reset()}
      className="flex flex-col gap-4 p-4"
      errors={formErrors}
      onSubmit={(e) => {
        e.preventDefault();
        detached(form.handleSubmit(), "invoices.submit");
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
              dir="ltr"
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
