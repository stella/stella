import { useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { CASE_LAW_RESEARCH_TABLE_NAME_MAX_LENGTH } from "@stll/api-contract";
import type {
  CaseLawResearchDisposition,
  CaseLawResearchYesNoValue,
} from "@stll/api-contract";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { createCaseDecisionViewTab } from "@/components/inspector/case-decision-view";
import { useInspectorView } from "@/components/inspector/use-inspector-view";
import type { Decision } from "@/features/case-law/components/decision-cells";
import {
  DECISION_COLUMN_IDS,
  DECISION_COLUMN_LABEL_KEYS,
  DECISION_GROUP_BY_OPTIONS,
  decisionTableSchema,
} from "@/features/case-law/decision-columns";
import type {
  DecisionColumnId,
  DecisionGroupBy,
} from "@/features/case-law/decision-columns";
import { decisionsInfiniteOptions } from "@/features/case-law/queries/decisions";
import {
  createResearchColumn,
  deleteResearchColumn,
  deleteResearchTable,
  renameResearchTable,
  researchAnswersOptions,
  researchTableKeys,
  researchTableOptions,
  runResearchAnswers,
  savedQueryToDecisionFilters,
  setResearchTableDecision,
  updateResearchColumn,
} from "@/features/case-law/research/queries";
import type {
  ResearchColumn,
  ResearchTableDetail,
  RunResearchAnswersScope,
} from "@/features/case-law/research/queries";
import { ResearchQuestionDialog } from "@/features/case-law/research/research-question-dialog";
import type { ResearchQuestionDraft } from "@/features/case-law/research/research-question-dialog";
import {
  answerGroupBy,
  answerKey,
  ResearchTableView,
} from "@/features/case-law/research/research-table-view";
import type {
  ResearchColumnAction,
  ResearchGroupBy,
} from "@/features/case-law/research/research-table-view";
import { mergeResearchRows } from "@/features/case-law/research/row-model";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import { pageTitleLiteral } from "@/lib/page-title";
import { createPublicLawHead } from "@/lib/public-law-seo";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { loadAuthContext } from "@/routes/-auth-context";

export const Route = createFileRoute("/law/cases/research/$tableId")({
  beforeLoad: async ({ context: { queryClient }, location }) => {
    const auth = await loadAuthContext(queryClient);
    const activeOrganizationId = auth.session?.activeOrganizationId;
    if (!activeOrganizationId) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: location.pathname },
      });
    }
    return { activeOrganizationId };
  },
  loader: async ({
    context: { activeOrganizationId, queryClient },
    params: { tableId },
  }) => {
    const detail = await ensureRouteQueryData(
      queryClient,
      researchTableOptions({ activeOrganizationId, tableId }),
    );
    // The rows are the saved query re-run; start it in the loader so the
    // table and its first page arrive in one round.
    await ensureRouteInfiniteQueryData(
      queryClient,
      decisionsInfiniteOptions(
        savedQueryToDecisionFilters(detail.table.savedQuery),
      ),
    );
    return { name: detail.table.name };
  },
  // A member's private working set: never crawled, never shared as a card.
  head: ({ loaderData, params }) =>
    createPublicLawHead({
      crawlAllowed: false,
      path: `/law/cases/research/${params.tableId}`,
      title: pageTitleLiteral(loaderData?.name ?? ""),
      type: "website",
    }),
  component: ResearchTablePage,
  pendingComponent: ResearchTablePending,
});

/** Every column but the language: the case-number cell already names it. */
const defaultVisibleColumns = (): ReadonlySet<DecisionColumnId> =>
  new Set(DECISION_COLUMN_IDS.filter((id) => id !== "language"));

const GROUP_BY_LABEL_KEYS = {
  none: "common.none",
  court: "common.court",
  country: "common.country",
  year: "workspaces.views.calendar.year",
  type: "common.type",
  language: "common.language",
} as const satisfies Record<DecisionGroupBy, TranslationKey>;

const isDecisionGroupBy = (value: string): value is DecisionGroupBy =>
  DECISION_GROUP_BY_OPTIONS.some((option) => option === value);

const isResearchGroupBy = (
  value: string,
  columns: readonly ResearchColumn[],
): value is ResearchGroupBy =>
  isDecisionGroupBy(value) ||
  columns.some((column) => answerGroupBy(column.id) === value);

/** Which question column a dialog edits, or that it adds one. */
type QuestionDialogState =
  | { mode: "closed" }
  | { mode: "add" }
  | { mode: "edit"; column: ResearchColumn };

const isDecisionColumnId = (value: string): value is DecisionColumnId =>
  DECISION_COLUMN_IDS.some((id) => id === value);

/** The columns a reader may toggle, narrowed once so closures keep the id type. */
const hideableColumnIds: DecisionColumnId[] = decisionTableSchema.columns
  .filter((column) => column.capabilities.hide)
  .map((column) => column.id)
  .filter(isDecisionColumnId);

function ResearchTablePending() {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <Skeleton className="h-7 w-72" />
      <Skeleton className="h-4 w-96" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-10 w-full rounded-md" />
        <Skeleton className="h-10 w-full rounded-md" />
      </div>
    </main>
  );
}

function ResearchTablePage() {
  const t = useTranslations();
  const navigate = Route.useNavigate();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const { activeOrganizationId } = Route.useRouteContext({
    select: (context) => ({
      activeOrganizationId: context.activeOrganizationId,
    }),
  });
  const tableId = Route.useParams({ select: (params) => params.tableId });
  const { data: detail } = useSuspenseQuery(
    researchTableOptions({ activeOrganizationId, tableId }),
  );
  const decisionsQuery = useInfiniteQuery(
    decisionsInfiniteOptions(
      savedQueryToDecisionFilters(detail.table.savedQuery),
    ),
  );
  const inspector = useInspectorView();

  const [groupBy, setGroupBy] = useState<ResearchGroupBy>("none");
  const [visibleColumns, setVisibleColumns] = useState<
    ReadonlySet<DecisionColumnId>
  >(defaultVisibleColumns);
  const [showExcluded, setShowExcluded] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [questionDialog, setQuestionDialog] = useState<QuestionDialogState>({
    mode: "closed",
  });
  const [yesNoFilters, setYesNoFilters] = useState<
    ReadonlyMap<string, CaseLawResearchYesNoValue>
  >(new Map());
  const [columnToDelete, setColumnToDelete] = useState<ResearchColumn | null>(
    null,
  );

  // A grouping or filter on a column that no longer exists falls back
  // silently; the column set is server state and can change under us.
  const answerColumns = detail.columns;
  const effectiveGroupBy: ResearchGroupBy = isResearchGroupBy(
    groupBy,
    answerColumns,
  )
    ? groupBy
    : "none";

  // Row edits bump the table's `updatedAt`, so the list's order and "last
  // edited" move too.
  const invalidateTable = async () =>
    await queryClient.invalidateQueries({ queryKey: researchTableKeys.all });
  const reportError = (error: unknown) => {
    analytics.captureError(error);
    stellaToast.add({ title: t("common.somethingWentWrong"), type: "error" });
  };

  const rename = useMutation({
    mutationFn: async (name: string) =>
      await renameResearchTable(tableId, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: researchTableKeys.all });
    },
    onError: reportError,
  });

  const renameTable = async (name: string): Promise<void> => {
    await rename.mutateAsync(name);
  };

  const setDisposition = useMutation({
    mutationFn: async ({
      decision,
      disposition,
    }: {
      decision: Decision;
      disposition: CaseLawResearchDisposition | null;
    }) =>
      await setResearchTableDecision({
        tableId,
        decisionId: decision.id,
        disposition,
      }),
    onSuccess: invalidateTable,
    onError: reportError,
  });

  const remove = useMutation({
    mutationFn: async () => await deleteResearchTable(tableId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: researchTableKeys.all });
      await navigate({ to: "/law/cases/research" });
    },
    onError: reportError,
  });

  const invalidateAnswers = async () =>
    await queryClient.invalidateQueries({
      queryKey: researchTableKeys.answers({ activeOrganizationId, tableId }),
    });

  const saveQuestion = useMutation({
    mutationFn: async ({
      column,
      draft,
    }: {
      column: ResearchColumn | null;
      draft: ResearchQuestionDraft;
    }) =>
      column === null
        ? await createResearchColumn({ tableId, ...draft })
        : await updateResearchColumn({
            tableId,
            columnId: column.id,
            ...draft,
          }),
    onSuccess: async () => {
      setQuestionDialog({ mode: "closed" });
      await Promise.all([invalidateTable(), invalidateAnswers()]);
    },
    onError: reportError,
  });

  const removeColumn = useMutation({
    mutationFn: async (column: ResearchColumn) =>
      await deleteResearchColumn({ tableId, columnId: column.id }),
    onSuccess: async () => {
      setColumnToDelete(null);
      await Promise.all([invalidateTable(), invalidateAnswers()]);
    },
    onError: reportError,
  });

  const queryRows: Decision[] = decisionsQuery.data
    ? decisionsQuery.data.pages.flatMap((page) => page.decisions)
    : [];
  const mergedRows = mergeResearchRows({
    dispositions: detail.decisions,
    pinnedDecisions: detail.pinnedDecisions,
    queryRows,
    showExcluded,
  });
  // Cells are fetched for the decisions on screen, separately from the rows:
  // they change while a run works, and the poll must not refetch the rows.
  const answersQuery = useQuery(
    researchAnswersOptions({
      activeOrganizationId,
      tableId,
      decisionIds: mergedRows.map((row) => row.decision.id).toSorted(),
    }),
  );
  const answersByKey = new Map(
    (answersQuery.data ?? []).map((answer) => [
      answerKey(answer.columnId, answer.decisionId),
      answer,
    ]),
  );
  // A filter on a column that no longer exists, or no longer asks a yes/no
  // question, would reject every row.
  const activeYesNoFilters = [...yesNoFilters].filter(([columnId]) =>
    answerColumns.some(
      (column) => column.id === columnId && column.answerType === "yes_no",
    ),
  );
  // A yes/no filter keeps the rows whose cell holds that value; cells that
  // were never answered are not "no", so they drop out too.
  const rows = mergedRows.filter((row) =>
    activeYesNoFilters.every(([columnId, wanted]) => {
      const answer = answersByKey.get(answerKey(columnId, row.decision.id));
      return (
        answer?.state === "answered" &&
        answer.answer?.type === "yes_no" &&
        answer.answer.value === wanted
      );
    }),
  );
  const excludedCount = detail.decisions.filter(
    (entry) => entry.disposition === "excluded",
  ).length;

  const run = useMutation({
    mutationFn: async (scope: RunResearchAnswersScope) =>
      await runResearchAnswers({
        ...scope,
        tableId,
        decisionIds: mergedRows
          .filter((row) => row.disposition !== "excluded")
          .map((row) => row.decision.id),
      }),
    onSuccess: async ({ queued }) => {
      if (queued === 0) {
        stellaToast.add({
          title: t("caseLaw.research.nothingToRun"),
          type: "info",
        });
      }
      await invalidateAnswers();
    },
    onError: reportError,
  });

  const onColumnAction = (
    column: ResearchColumn,
    action: ResearchColumnAction,
  ) => {
    switch (action) {
      case "run":
        run.mutate({ scope: "column", columnId: column.id });
        return;
      case "edit":
        setQuestionDialog({ mode: "edit", column });
        return;
      case "delete":
        setColumnToDelete(column);
        return;
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  };

  const showSource = (decision: Decision, anchorId: string) => {
    inspector.open(
      createCaseDecisionViewTab({
        anchorId,
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId: decision.id,
        language: decision.language,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
      }),
    );
  };

  const pendingCount = (answersQuery.data ?? []).filter(
    (answer) => answer.state === "pending",
  ).length;

  // A run is a detached continuation of the request that queued it. If the
  // process serving it went away, its cells stay pending past the stale
  // window (the server marks them); the first reader to notice queues them
  // again, once per visit, and the server skips whatever a live run holds.
  const hasStalePending = (answersQuery.data ?? []).some(
    (answer) => answer.stale,
  );
  const [resumedStale, setResumedStale] = useState(false);
  useExternalSyncEffect(() => {
    if (!hasStalePending || resumedStale || run.isPending) {
      return;
    }
    setResumedStale(true);
    run.mutate({ scope: "table" });
  }, [hasStalePending, resumedStale, run]);

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <TableNameField name={detail.table.name} onRename={renameTable} />
          <SavedQuerySummary table={detail.table} />
        </div>
        <Button
          render={<Link to="/law/cases/research" />}
          size="sm"
          variant="ghost"
        >
          {t("caseLaw.research.title")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          onValueChange={(value: string | null) => {
            if (value !== null && isResearchGroupBy(value, answerColumns)) {
              setGroupBy(value);
            }
          }}
          value={effectiveGroupBy}
        >
          <SelectTrigger
            aria-label={t("caseLaw.research.groupBy")}
            className="h-8 w-56 text-xs"
          >
            <SelectValue placeholder={t("caseLaw.research.groupBy")} />
          </SelectTrigger>
          <SelectPopup>
            {DECISION_GROUP_BY_OPTIONS.map((option) => (
              <SelectItem key={option} value={option}>
                {option === "none"
                  ? t("caseLaw.research.groupBy")
                  : t(GROUP_BY_LABEL_KEYS[option])}
              </SelectItem>
            ))}
            {answerColumns.map((column) => (
              <SelectItem key={column.id} value={answerGroupBy(column.id)}>
                {t("caseLaw.research.groupByAnswer", {
                  question: column.question,
                })}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>

        <Button
          onClick={() => setQuestionDialog({ mode: "add" })}
          size="sm"
          variant="outline"
        >
          {t("caseLaw.research.addQuestion")}
        </Button>
        {answerColumns.length > 0 && (
          <Button
            disabled={run.isPending || rows.length === 0}
            onClick={() => run.mutate({ scope: "table" })}
            size="sm"
            variant="outline"
          >
            {pendingCount > 0
              ? t("caseLaw.research.answering", { count: pendingCount })
              : t("caseLaw.research.runAll")}
          </Button>
        )}

        <Menu>
          <MenuTrigger render={<Button size="sm" variant="outline" />}>
            {t("common.columns")}
          </MenuTrigger>
          <MenuPopup>
            {hideableColumnIds.map((columnId) => (
              <MenuCheckboxItem
                checked={visibleColumns.has(columnId)}
                closeOnClick={false}
                key={columnId}
                onCheckedChange={(checked) => {
                  setVisibleColumns((current) => {
                    const next = new Set(current);
                    if (checked) {
                      next.add(columnId);
                    } else {
                      next.delete(columnId);
                    }
                    return next;
                  });
                }}
              >
                {t(DECISION_COLUMN_LABEL_KEYS[columnId])}
              </MenuCheckboxItem>
            ))}
          </MenuPopup>
        </Menu>

        {excludedCount > 0 && (
          <Button
            onClick={() => setShowExcluded((current) => !current)}
            size="sm"
            variant="ghost"
          >
            {showExcluded
              ? t("caseLaw.research.hideExcluded")
              : t("caseLaw.research.showExcluded")}
            <span className="text-muted-foreground ms-1 text-xs tabular-nums">
              {t("caseLaw.research.excludedCount", { count: excludedCount })}
            </span>
          </Button>
        )}

        <span className="text-muted-foreground ms-auto text-xs tabular-nums">
          {t("caseLaw.research.rows", { count: rows.length })}
        </span>

        <Button
          onClick={() => setDeleteOpen(true)}
          size="sm"
          variant="destructive-outline"
        >
          {t("common.delete")}
        </Button>
      </div>

      <ResearchTableView
        answerColumns={answerColumns}
        answersByKey={answersByKey}
        groupBy={effectiveGroupBy}
        isLoading={decisionsQuery.isLoading}
        onColumnAction={onColumnAction}
        onSetDisposition={(decision, disposition) => {
          detached(
            setDisposition.mutateAsync({ decision, disposition }),
            "research-table.set-disposition",
          );
        }}
        onSetYesNoFilter={(column, value) => {
          setYesNoFilters((current) => {
            const next = new Map(current);
            if (value === null) {
              next.delete(column.id);
            } else {
              next.set(column.id, value);
            }
            return next;
          });
        }}
        onShowSource={showSource}
        rows={rows}
        visibleColumns={visibleColumns}
        yesNoFilters={yesNoFilters}
      />

      {questionDialog.mode !== "closed" && (
        <ResearchQuestionDialog
          initial={
            questionDialog.mode === "edit"
              ? {
                  question: questionDialog.column.question,
                  answerType: questionDialog.column.answerType,
                }
              : undefined
          }
          isPending={saveQuestion.isPending}
          key={
            questionDialog.mode === "edit" ? questionDialog.column.id : "add"
          }
          onOpenChange={(open) => {
            if (!open) {
              setQuestionDialog({ mode: "closed" });
            }
          }}
          onSubmit={(draft) => {
            saveQuestion.mutate({
              column:
                questionDialog.mode === "edit" ? questionDialog.column : null,
              draft,
            });
          }}
          open
        />
      )}

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setColumnToDelete(null);
          }
        }}
        open={columnToDelete !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("caseLaw.research.deleteColumn")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("caseLaw.research.deleteColumnConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={removeColumn.isPending}
              onClick={() => {
                if (columnToDelete !== null) {
                  removeColumn.mutate(columnToDelete);
                }
              }}
              variant="destructive"
            >
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      {decisionsQuery.hasNextPage && (
        <div className="flex justify-center py-4">
          <Button
            disabled={decisionsQuery.isFetchingNextPage}
            onClick={() => {
              detached(
                decisionsQuery.fetchNextPage(),
                "research-table.fetch-next-page",
              );
            }}
            variant="outline"
          >
            {decisionsQuery.isFetchingNextPage
              ? t("caseLaw.loadingMore")
              : t("common.loadMore")}
          </Button>
        </div>
      )}

      <AlertDialog onOpenChange={setDeleteOpen} open={deleteOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("caseLaw.research.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("caseLaw.research.deleteConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={remove.isPending}
              onClick={() => {
                detached(remove.mutateAsync(), "research-table.delete");
              }}
              variant="destructive"
            >
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </main>
  );
}

/**
 * The table's name, edited in place. The field owns the draft while it has
 * focus and hands it back on blur or Enter; the server value wins otherwise,
 * including when the rename is refused (the caller has already reported it).
 */
function TableNameField({
  name,
  onRename,
}: {
  name: string;
  onRename: (name: string) => Promise<void>;
}) {
  const t = useTranslations();
  const [draft, setDraft] = useState(name);
  const [syncedName, setSyncedName] = useState(name);
  if (syncedName !== name) {
    setSyncedName(name);
    setDraft(name);
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setDraft(name);
      return;
    }
    if (trimmed !== name) {
      detached(
        onRename(trimmed).catch(() => {
          setDraft(name);
        }),
        "research-table.rename",
      );
    }
  };

  return (
    <Input
      aria-label={t("common.name")}
      className="hover:border-input focus-visible:border-input h-9 max-w-xl border-transparent bg-transparent px-1 text-lg font-semibold shadow-none"
      maxLength={CASE_LAW_RESEARCH_TABLE_NAME_MAX_LENGTH}
      onBlur={commit}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(name);
        }
      }}
      placeholder={t("caseLaw.research.namePlaceholder")}
      value={draft}
    />
  );
}

/** The saved search as quiet chips: the words, then each filter that narrows it. */
function SavedQuerySummary({ table }: { table: ResearchTableDetail["table"] }) {
  const t = useTranslations();
  const format = useFormatter();
  const { savedQuery } = table;
  const formatBoundary = (value: string | undefined): string => {
    const date = value === undefined ? null : parseDeterministicDate(value);
    return date === null
      ? "…"
      : format.dateTime(date, { dateStyle: "medium", timeZone: "UTC" });
  };
  const chips: string[] = [];
  if (savedQuery.country !== undefined) {
    chips.push(savedQuery.country);
  }
  if (savedQuery.court !== undefined) {
    chips.push(savedQuery.court);
  }
  if (savedQuery.decisionType !== undefined) {
    chips.push(savedQuery.decisionType);
  }
  if (savedQuery.language !== undefined) {
    chips.push(savedQuery.language.toUpperCase());
  }
  if (savedQuery.dateFrom !== undefined || savedQuery.dateTo !== undefined) {
    chips.push(
      `${formatBoundary(savedQuery.dateFrom)} – ${formatBoundary(savedQuery.dateTo)}`,
    );
  }

  return (
    <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs">
      <span>
        {t("caseLaw.research.savedQuery")}:{" "}
        <span className="text-foreground">{savedQuery.query}</span>
      </span>
      {chips.map((chip) => (
        <span className="bg-muted rounded px-1.5 py-0.5" key={chip}>
          {chip}
        </span>
      ))}
    </p>
  );
}
