import { useState } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { UNPRICED_TIME_ENTRY_CURRENCY } from "@stll/api-contract";
import type { TimeApprovalRefusal } from "@stll/api-contract/time-entries";
import { timeEntryAmount } from "@stll/money";
import { Temporal } from "@stll/time";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Input } from "@stll/ui/input";

import { formatCurrencyAmount } from "@/components/billing/format-currency";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { MEDIUM_DATE_FORMAT } from "@/lib/relative-time";
import { expensesQueryRoot } from "@/lib/resource-query-roots.logic";
import { formatMinutes } from "@/lib/workspaces/format-duration";
import { useUpdateExpense } from "@/lib/workspaces/mutations/expenses";
import {
  useApproveTimeEntries,
  useReturnTimeEntry,
} from "@/lib/workspaces/mutations/time-entries";
import { expensesOptions } from "@/lib/workspaces/queries/expenses";
import { invoicesKeys } from "@/lib/workspaces/queries/invoices";
import { timeEntriesOptions } from "@/lib/workspaces/queries/time-entries";

const REFUSAL_KEYS = {
  not_found: "billing.approval.refusals.notFound",
  not_approver: "billing.approval.refusals.notApprover",
  wrong_status: "billing.approval.refusals.wrongStatus",
  running_timer: "billing.approval.refusals.runningTimer",
  unpriced: "billing.approval.refusals.unpriced",
  time_period_locked: "billing.globalTimer.periodLocked",
  invalid_entry: "billing.approval.refusals.invalidEntry",
} as const satisfies Record<TimeApprovalRefusal, TranslationKey>;

const isRefusal = (code: string | undefined): code is TimeApprovalRefusal =>
  code !== undefined && Object.hasOwn(REFUSAL_KEYS, code);

type Props = { workspaceId: string };

/**
 * The matter's draft time and expenses from every timekeeper, for someone
 * who may approve them; invoices bill only approved work. Nothing renders for
 * anyone else, mirroring the API's `timeEntry:approve` check.
 */
export const MatterApprovalView = ({ workspaceId }: Props) => {
  const canApprove = usePermissions({ timeEntry: ["approve"] });
  return canApprove ? <ApprovalLists workspaceId={workspaceId} /> : null;
};

/** Per-item errors, shown next to the entry or expense they are about. */
const useItemErrors = () => {
  const t = useTranslations();
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const failed = t("billing.approval.failed");
  return {
    errors,
    refusalText: (reason: TimeApprovalRefusal) => t(REFUSAL_KEYS[reason]),
    errorText: (error: unknown) =>
      APIError.is(error) && isRefusal(error.code)
        ? t(REFUSAL_KEYS[error.code])
        : userErrorFromThrown(error, failed),
    /** Replaces the errors of `ids` with `next`, keeping everyone else's. */
    show: (ids: readonly string[], next: Readonly<Record<string, string>>) =>
      setErrors((current) => ({
        ...Object.fromEntries(
          Object.entries(current).filter(([id]) => !ids.includes(id)),
        ),
        ...next,
      })),
  };
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
  const { data: draftEntries } = useSuspenseQuery(
    timeEntriesOptions(workspaceId, userId, { status: "draft" }),
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
    draftEntries.length === 0 &&
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
        draftEntries={draftEntries}
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

const TimeApprovals = ({
  workspaceId,
  draftEntries,
  approvedEntries,
}: Props & {
  draftEntries: readonly TimeEntryItem[];
  approvedEntries: readonly TimeEntryItem[];
}) => {
  const t = useTranslations();
  const workDate = useWorkDate();
  const itemErrors = useItemErrors();
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [comments, setComments] = useState<Record<string, string>>({});
  const approve = useApproveTimeEntries();
  const returnEntry = useReturnTimeEntry();

  // A checked entry that another approver handled meanwhile is no longer here.
  const selected = draftEntries
    .filter((entry) => checked.has(entry.id))
    .map((entry) => entry.id);
  const approveEntries = (ids: readonly string[]) => {
    approve.mutate(
      { workspaceId, ids },
      {
        onSuccess: ({ results }) => {
          itemErrors.show(
            ids,
            Object.fromEntries(
              results.flatMap((result) =>
                result.status === "refused"
                  ? [[result.id, itemErrors.refusalText(result.reason)]]
                  : [],
              ),
            ),
          );
          setChecked((current) => {
            const next = new Set(current);
            for (const id of ids) {
              next.delete(id);
            }
            return next;
          });
        },
        onError: (error) =>
          itemErrors.show(
            ids,
            Object.fromEntries(
              ids.map((id) => [id, itemErrors.errorText(error)]),
            ),
          ),
      },
    );
  };
  const isApproving = (id: string) =>
    approve.isPending && approve.variables.ids.includes(id);
  const returnToDraft = (id: string) =>
    returnEntry.mutate(
      { workspaceId, id, comment: comments[id]?.trim() ?? "" },
      {
        onSuccess: () => itemErrors.show([id], {}),
        onError: (error) =>
          itemErrors.show([id], { [id]: itemErrors.errorText(error) }),
      },
    );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex min-h-9 items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          {t("billing.approval.timeEntries")}
        </h2>
        {selected.length > 0 && (
          <Button
            loading={approve.isPending}
            onClick={() => approveEntries(selected)}
            size="sm"
          >
            {t("billing.approval.approveSelected", { count: selected.length })}
          </Button>
        )}
      </div>
      {draftEntries.map((entry) => (
        <div className="rounded-md border p-3" key={entry.id}>
          <div className="flex items-start gap-3">
            <Checkbox
              aria-label={t("billing.approval.selectEntry")}
              checked={checked.has(entry.id)}
              onCheckedChange={(value) =>
                setChecked((current) => {
                  const next = new Set(current);
                  if (value) {
                    next.add(entry.id);
                  } else {
                    next.delete(entry.id);
                  }
                  return next;
                })
              }
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-x-4 text-sm tabular-nums">
                <strong>{entry.userName}</strong>
                <span>{workDate(entry.dateWorked)}</span>
                <span>{formatMinutes(entry.durationMinutes)}</span>
                {entry.currency === UNPRICED_TIME_ENTRY_CURRENCY ? (
                  <span>{t("billing.rates.noRateFound")}</span>
                ) : (
                  <>
                    <span>
                      {formatCurrencyAmount(entry.rateAtEntry, entry.currency)}
                    </span>
                    <span>
                      {formatCurrencyAmount(
                        timeEntryAmount(entry),
                        entry.currency,
                      )}
                    </span>
                  </>
                )}
              </div>
              <p className="text-muted-foreground mt-1 text-sm" dir="auto">
                {entry.narrative}
              </p>
              <ItemError message={itemErrors.errors[entry.id]} />
            </div>
            <Button
              disabled={approve.isPending && !isApproving(entry.id)}
              loading={isApproving(entry.id)}
              onClick={() => approveEntries([entry.id])}
              size="sm"
            >
              {t("billing.approve")}
            </Button>
          </div>
        </div>
      ))}
      {approvedEntries.length > 0 && (
        <h3 className="text-muted-foreground text-xs font-medium">
          {t("billing.statuses.approved")}
        </h3>
      )}
      {approvedEntries.map((entry) => (
        <div className="rounded-md border p-3" key={entry.id}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 text-sm" dir="auto">
              {entry.userName}: {entry.narrative}
            </span>
            <Input
              aria-label={t("billing.approval.returnComment")}
              className="max-w-64"
              onChange={(event) =>
                setComments((value) => ({
                  ...value,
                  [entry.id]: event.target.value,
                }))
              }
              placeholder={t("billing.approval.returnComment")}
              value={comments[entry.id] ?? ""}
            />
            <Button
              disabled={!comments[entry.id]?.trim()}
              loading={
                returnEntry.isPending && returnEntry.variables.id === entry.id
              }
              onClick={() => returnToDraft(entry.id)}
              size="sm"
              variant="outline"
            >
              {t("billing.revertToDraft")}
            </Button>
          </div>
          <ItemError message={itemErrors.errors[entry.id]} />
        </div>
      ))}
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

  const setStatus = (id: string, status: "draft" | "approved") =>
    updateExpense.mutate(
      { workspaceId, id, status },
      {
        onSuccess: () => {
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
        },
        onError: (error) =>
          itemErrors.show([id], { [id]: itemErrors.errorText(error) }),
      },
    );
  const isUpdating = (id: string) =>
    updateExpense.isPending && updateExpense.variables.id === id;

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
              loading={isUpdating(expense.id)}
              onClick={() => setStatus(expense.id, "approved")}
              size="sm"
            >
              {t("billing.approve")}
            </Button>
          ) : (
            <Button
              loading={isUpdating(expense.id)}
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
