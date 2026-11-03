import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import { ReturnSelected } from "@/features/time-review/return-selected";
import {
  TimeReviewRow,
  type TimeReviewRowData,
} from "@/features/time-review/time-review-row";
import {
  useItemErrors,
  usePendingRows,
  useTimeReview,
} from "@/features/time-review/use-time-review";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";
import { expensesQueryRoot } from "@/lib/resource-query-roots.logic";
import { useUpdateExpense } from "@/lib/workspaces/mutations/expenses";
import { expensesOptions } from "@/lib/workspaces/queries/expenses";
import { invoicesKeys } from "@/lib/workspaces/queries/invoices";
import { timeEntriesOptions } from "@/lib/workspaces/queries/time-entries";

type Props = { workspaceId: string };

/**
 * The matter's submitted time and draft expenses from every timekeeper, for
 * someone who may approve them; invoices bill only approved work. Nothing
 * renders for anyone else, mirroring the API's `timeEntry:approve` check.
 */
export const MatterApprovalView = ({ workspaceId }: Props) => {
  const canApprove = usePermissions({ timeEntry: ["approve"] });
  return canApprove ? <ApprovalLists workspaceId={workspaceId} /> : null;
};

const useWorkDate = () => {
  const format = useFormatter();
  return (date: string) =>
    format.dateTime(
      Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: "UTC" })
        .epochMilliseconds,
      { ...MEDIUM_DATE_FORMAT, timeZone: "UTC" },
    );
};

const ItemError = ({ message }: { message: string | undefined }) =>
  message === undefined ? null : (
    <p className="text-destructive mt-1 text-sm" role="alert">
      {message}
    </p>
  );

const ApprovalLists = ({ workspaceId }: Props) => {
  const t = useTranslations();
  const canApproveExpenses = usePermissions({ expense: ["update"] });
  const userId = useRouteContext({
    from: "/_protected",
    select: (context) => context.user.id,
  });
  const { data: submittedEntries } = useSuspenseQuery(
    timeEntriesOptions(workspaceId, userId, { status: "submitted" }),
  );
  const { data: approvedEntries } = useSuspenseQuery(
    timeEntriesOptions(workspaceId, userId, { status: "approved" }),
  );
  const { data: draftExpenses } = useSuspenseQuery(
    expensesOptions(workspaceId, { status: "draft" }),
  );
  const { data: approvedExpenses } = useSuspenseQuery(
    expensesOptions(workspaceId, { status: "approved" }),
  );
  const expenses = canApproveExpenses
    ? [...draftExpenses, ...approvedExpenses]
    : [];

  if (
    submittedEntries.length === 0 &&
    approvedEntries.length === 0 &&
    expenses.length === 0
  ) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("billing.approval.empty")}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <TimeApprovals
        approvedEntries={approvedEntries}
        submittedEntries={submittedEntries}
        workspaceId={workspaceId}
      />
      {expenses.length > 0 && (
        <ExpenseApprovals expenses={expenses} workspaceId={workspaceId} />
      )}
    </div>
  );
};

type TimeEntryItem = Awaited<
  ReturnType<NonNullable<ReturnType<typeof timeEntriesOptions>["queryFn"]>>
>[number];

const reviewRowOf =
  (workspaceId: string) =>
  (entry: TimeEntryItem): TimeReviewRowData => ({
    id: entry.id,
    workspaceId,
    timekeeperName: entry.userName,
    matterName: null,
    dateWorked: entry.dateWorked,
    durationMinutes: entry.durationMinutes,
    billedMinutes: entry.billedMinutes,
    rateAtEntry: entry.rateAtEntry,
    currency: entry.currency,
    billable: entry.billable,
    noCharge: entry.noCharge,
    narrative: entry.narrative,
    returnComment: entry.returnComment,
  });

const TimeApprovals = ({
  workspaceId,
  submittedEntries,
  approvedEntries,
}: Props & {
  submittedEntries: readonly TimeEntryItem[];
  approvedEntries: readonly TimeEntryItem[];
}) => {
  const t = useTranslations();
  const review = useTimeReview();
  const submitted = submittedEntries.map(reviewRowOf(workspaceId));
  const approved = approvedEntries.map(reviewRowOf(workspaceId));
  // A checked entry that another approver handled meanwhile is no longer here.
  const selected = review.selectedOf(submitted);
  const show = { timekeeper: true, matter: false, date: true };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          {t("billing.approval.timeEntries")}
        </h2>
        {selected.length > 0 && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ReturnSelected review={review} selected={selected} />
            <Button
              loading={selected.some(({ id }) => review.isPending(id))}
              onClick={() => review.approve(selected)}
              size="sm"
            >
              {t("billing.approval.approveSelected", {
                count: selected.length,
              })}
            </Button>
          </div>
        )}
      </div>
      <ul className="flex flex-col gap-3">
        {submitted.map((row) => (
          <TimeReviewRow
            key={row.id}
            review={review}
            row={row}
            show={show}
            stage="submitted"
          />
        ))}
      </ul>
      {approved.length > 0 && (
        <h3 className="text-muted-foreground text-xs font-medium">
          {t("billing.statuses.approved")}
        </h3>
      )}
      <ul className="flex flex-col gap-3">
        {approved.map((row) => (
          <TimeReviewRow
            key={row.id}
            review={review}
            row={row}
            show={show}
            stage="approved"
          />
        ))}
      </ul>
    </section>
  );
};

type ExpenseItem = Awaited<
  ReturnType<NonNullable<ReturnType<typeof expensesOptions>["queryFn"]>>
>[number];

const ExpenseApprovals = ({
  workspaceId,
  expenses,
}: Props & { expenses: readonly ExpenseItem[] }) => {
  const t = useTranslations();
  const workDate = useWorkDate();
  const itemErrors = useItemErrors();
  const updateExpense = useUpdateExpense();
  const queryClient = useQueryClient();
  const pending = usePendingRows();

  const requestStatus = async (id: string, status: "draft" | "approved") => {
    const outcome = await updateExpense
      .mutateAsync({ workspaceId, id, status })
      .then(
        () => ({ type: "updated" as const }),
        (error: unknown) => ({ type: "failed" as const, error }),
      );
    if (outcome.type === "failed") {
      itemErrors.show([id], { [id]: itemErrors.errorText(outcome.error) });
      return;
    }
    itemErrors.show([id], {});
    detached(
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: expensesQueryRoot(workspaceId),
        }),
        queryClient.invalidateQueries({
          queryKey: invoicesKeys.all(workspaceId),
        }),
      ]),
      "matter-approval.expense-refresh",
    );
  };
  const setStatus = (id: string, status: "draft" | "approved") =>
    detached(
      pending.track([id], requestStatus(id, status)),
      "matter-approval.update-expense",
    );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{t("common.expenses")}</h2>
      {expenses.map((expense) => (
        <div
          className="flex items-center gap-3 rounded-md border p-3"
          key={expense.id}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm" dir="auto">
              {expense.userName}: {expense.description}
            </p>
            <p className="text-muted-foreground text-sm tabular-nums">
              {workDate(expense.dateIncurred)} ·{" "}
              {formatCurrencyAmount(expense.amount, expense.currency)}
            </p>
            <ItemError message={itemErrors.errors[expense.id]} />
          </div>
          {expense.status === "draft" ? (
            <Button
              loading={pending.has(expense.id)}
              onClick={() => setStatus(expense.id, "approved")}
              size="sm"
            >
              {t("billing.approve")}
            </Button>
          ) : (
            <Button
              loading={pending.has(expense.id)}
              onClick={() => setStatus(expense.id, "draft")}
              size="sm"
              variant="outline"
            >
              {t("billing.revertToDraft")}
            </Button>
          )}
        </div>
      ))}
    </section>
  );
};
