import { useState } from "react";
/**
 * The organization's question columns on a decision table: which of them this
 * search draws, and what the reader can add, edit, remove and run.
 *
 * The hook holds the state because two places need it — the table's own column
 * headers and the toolbar's controls — and a controller passed between them is
 * cheaper than a context nobody else reads.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

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
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { AiColumnSelectionAction } from "@/components/workspaces/ai-column-run-controls";
import { aiColumnRunScope } from "@/components/workspaces/ai-column-run.logic";
import { BulkAddColumns } from "@/components/workspaces/bulk-add-columns";
import type { Decision } from "@/features/case-law/components/decision-cells";
import { AddQuestionColumn } from "@/features/case-law/research/add-question-column";
import {
  deleteQuestionColumn,
  questionAnswersOptions,
  questionColumnKeys,
  questionColumnsOptions,
  runAnswers,
} from "@/features/case-law/research/queries";
import {
  answerKey,
  NO_QUESTION_ANSWERS,
  NO_QUESTION_COLUMNS,
  questionColumnSurface,
  questionReads,
  questionRunSet,
  questionQueuedAnswerKeys,
  questionRefusedAnswerKeys,
} from "@/features/case-law/research/question-columns.logic";
import type {
  QuestionAnswer,
  QuestionColumn,
  QuestionColumnAction,
  QuestionColumnGrants,
  QuestionColumnRunOptions,
  QuestionColumnSurface,
  QuestionRunSet,
  QuestionSuggestionSearch,
} from "@/features/case-law/research/question-columns.logic";
import {
  questionsOnSearch,
  withoutQuestionOnSearch,
  withQuestionsOnSearch,
} from "@/features/case-law/research/search-questions.logic";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { usePermissions } from "@/hooks/use-permissions";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { notifyUserError } from "@/lib/errors/user-toast";
import { useQueryView } from "@/lib/use-query-view";

type QuestionColumnsInput = {
  /**
   * Whether this surface asks questions at all. A surface that may hold no
   * rows — a matter with nothing linked — passes what it already knows, so the
   * organization's columns are never read speculatively on a route that will
   * not draw them.
   */
  enabled: boolean;
  /** Every decision on the page, in the order it is drawn. */
  pageDecisionIds: readonly string[];
  /** The rows the reader picked; empty means the whole page. */
  selectedDecisionIds: readonly string[];
  /**
   * The search these rows came from. It grounds a new question's suggested
   * wording; a surface whose rows were never searched for passes
   * `UNSEARCHED_SCOPE`.
   */
  search: QuestionSuggestionSearch;
  /** Opens a decision at a cited passage, with the reader's highlight. */
  onShowPassage: (decision: Decision, anchorId: string) => void;
  /** The questions this search shows, in order, as its URL names them. */
  shownQuestionIds: readonly string[];
  /**
   * Rewrites that list from the one the URL holds when the write lands, so a
   * write that settles late (a delete) cannot restore an id dropped meanwhile.
   */
  onShownQuestionIdsChange: (
    update: (shownIds: readonly string[]) => string[] | undefined,
  ) => void;
};

/** One queue request: a confirmed run, or the retry of a single failed cell. */
type RunRequest = {
  /** Answer again where an answer already stands. */
  force: boolean;
  runSet: QuestionRunSet;
};

/** A run the reader has been shown the size of and has not yet confirmed. */
type PendingRun = {
  force: boolean;
  runSet: QuestionRunSet;
  /** Named so the toast and the dialog can say which question is being asked. */
  question: string | null;
};

export type QuestionColumnsController = {
  surface: QuestionColumnSurface;
  /** The question the composer is reworking, or that it is writing a new one. */
  editing: QuestionColumn | null;
  onEditingChange: (column: QuestionColumn | null) => void;
  pendingRun: PendingRun | null;
  onCancelRun: () => void;
  onConfirmRun: () => void;
  removing: QuestionColumn | null;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
};

const NO_ADDED_IDS: ReadonlySet<string> = new Set();
const ANSWER_BUDGET_REFUSAL_CODE = "usage_limit_exceeded";
const DEFAULT_RUN_OPTIONS = {
  type: "remaining",
  scope: "selection",
} as const satisfies QuestionColumnRunOptions;

export const useQuestionColumns = ({
  enabled,
  onShowPassage,
  onShownQuestionIdsChange,
  pageDecisionIds,
  search,
  selectedDecisionIds,
  shownQuestionIds,
}: QuestionColumnsInput): QuestionColumnsController => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const authStatus = useClientAuthStatus();
  const activeOrganizationId = authStatus.isAuthenticated
    ? authStatus.user.activeOrganizationId
    : null;
  // One question per action, because the organization grants them separately:
  // a reader may be licensed to write a question and not to pay for answering
  // it. `usePermissions` fails closed while the role cache is cold.
  const grants = {
    create: usePermissions({ caseLawResearch: ["create"] }),
    update: usePermissions({ caseLawResearch: ["update"] }),
    delete: usePermissions({ caseLawResearch: ["delete"] }),
    run: usePermissions({ caseLawResearch: ["run"] }),
  } satisfies QuestionColumnGrants;

  const [editing, setEditing] = useState<QuestionColumn | null>(null);
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);
  // Questions added during this visit, so their headers can say so.
  const [addedIds, setAddedIds] = useState<ReadonlySet<string>>(NO_ADDED_IDS);
  const [removing, setRemoving] = useState<QuestionColumn | null>(null);

  const columnsQuery = useQuery({
    ...questionColumnsOptions({
      activeOrganizationId: activeOrganizationId ?? "",
    }),
    enabled: enabled && activeOrganizationId !== null,
  });
  // Sorted, so the same page asks the same cache question whatever order the
  // rows arrived in.
  const decisionIds = [...pageDecisionIds].toSorted();
  const answersQuery = useQuery({
    ...questionAnswersOptions({
      activeOrganizationId: activeOrganizationId ?? "",
      decisionIds,
    }),
    enabled: enabled && activeOrganizationId !== null && decisionIds.length > 0,
  });

  const columnsView = useQueryView(columnsQuery);
  const answersView = useQueryView(answersQuery);
  const reads = questionReads({
    columns: columnsView,
    answers: decisionIds.length === 0 ? null : answersView,
  });
  const columns = reads.type === "ready" ? reads.columns : NO_QUESTION_COLUMNS;
  const answers = reads.type === "ready" ? reads.answers : NO_QUESTION_ANSWERS;
  const canRun =
    reads.type === "ready" &&
    reads.answersStatus === "ready" &&
    reads.notice === undefined;

  // Only what this search shows is drawn, run and searched; the rest of the
  // organization's questions are offered for adding.
  const { shown, addable } = questionsOnSearch({
    library: columns,
    shownIds: shownQuestionIds,
  });
  const answersByKey = new Map<string, QuestionAnswer>();
  for (const answer of answers) {
    answersByKey.set(answerKey(answer.columnId, answer.decisionId), answer);
  }

  const reportFailure = (error: unknown) => {
    analytics.captureError(error);
    notifyUserError(error, t("common.somethingWentWrong"));
  };

  const invalidateColumns = async () => {
    await queryClient.invalidateQueries({ queryKey: questionColumnKeys.all });
  };

  const remove = useMutation({
    mutationFn: async (columnId: string) =>
      await deleteQuestionColumn(columnId),
    onSuccess: async (_deleted, columnId) => {
      setRemoving(null);
      onShownQuestionIdsChange((shownIds) =>
        withoutQuestionOnSearch(shownIds, columnId),
      );
      await invalidateColumns();
    },
    onError: reportFailure,
  });

  // The shared policy skips active work and licensing refusals even when forced.
  const run = useMutation({
    mutationFn: async ({ force, runSet }: RunRequest) =>
      await runAnswers({
        columnIds: runSet.columnIds,
        decisionIds: runSet.decisionIds,
        ...(force ? { force: true } : {}),
      }),
    onSuccess: async ({ queued }) => {
      setPendingRun(null);
      stellaToast.add({
        title: t("caseLaw.research.answering", { count: queued }),
        type: "success",
      });
      await invalidateColumns();
    },
    onError: (error) => {
      setPendingRun(null);
      reportFailure(error);
    },
  });

  /** Ask for a run, or say there is nothing to ask; never run silently. */
  const askToRun = (
    column: QuestionColumn | null,
    options: QuestionColumnRunOptions = DEFAULT_RUN_OPTIONS,
  ) => {
    if (!canRun) {
      return;
    }
    const runSet = questionRunSet({
      answersByKey,
      ...(column === null ? {} : { columnId: column.id }),
      columns: shown,
      pageDecisionIds,
      selectedDecisionIds: options.scope === "page" ? [] : selectedDecisionIds,
      force: options.type === "rerun",
    });
    if (runSet.cells === 0) {
      stellaToast.add({ title: t("caseLaw.research.nothingToRun") });
      return;
    }
    setPendingRun({
      force: options.type === "rerun",
      runSet,
      question: column === null ? null : column.question,
    });
  };

  /**
   * A question joins the table at its end, often past the columns on screen,
   * with no answers until it is run: say that it arrived and offer the run,
   * so the press is never answered by nothing visible.
   */
  const announceAdded = (columnIds: readonly string[]) => {
    for (const columnId of columnIds) {
      const column = columns.find((known) => known.id === columnId);
      if (column === undefined) {
        continue;
      }
      stellaToast.add({
        title: t("caseLaw.research.questionAdded", {
          question: column.question,
        }),
        ...(canRun
          ? {
              actionProps: {
                children: t("caseLaw.research.runConfirm"),
                onClick: () => askToRun(column),
              },
            }
          : {}),
      });
    }
  };

  const onColumnAction = (
    column: QuestionColumn,
    action: QuestionColumnAction,
  ) => {
    switch (action) {
      case "run":
        askToRun(column);
        break;
      case "edit":
        setEditing(column);
        break;
      case "remove":
        onShownQuestionIdsChange((shownIds) =>
          withoutQuestionOnSearch(shownIds, column.id),
        );
        break;
      case "delete":
        setRemoving(column);
        break;
      default:
        action satisfies never;
        panic(`Unhandled question column action: ${String(action)}`);
    }
  };

  return {
    surface:
      enabled && activeOrganizationId !== null && reads.type !== "ready"
        ? reads
        : questionColumnSurface({
            // The same two answers that gated the reads above gate the controls: a
            // surface that asks nothing draws no rail, so nothing reads the
            // organization's columns to decide whether the rail is at its cap.
            activeOrganizationId,
            enabled,
            answersByKey,
            pageDecisionIds,
            selectedDecisionIds,
            queuedAnswerKeys: run.isPending
              ? questionQueuedAnswerKeys({
                  answersByKey,
                  force: run.variables.force,
                  runSet: run.variables.runSet,
                })
              : NO_ADDED_IDS,
            refusedAnswerKeys:
              run.isError &&
              APIError.is(run.error) &&
              run.error.code === ANSWER_BUDGET_REFUSAL_CODE
                ? questionRefusedAnswerKeys({
                    answersByKey,
                    runSet: run.variables.runSet,
                  })
                : NO_ADDED_IDS,
            onRunColumn: askToRun,
            onRunSelectedRows: () => askToRun(null),
            columns: shown,
            addable,
            onAddToSearch: (columnIds) => {
              onShownQuestionIdsChange((shownIds) =>
                withQuestionsOnSearch({
                  added: columnIds,
                  knownIds:
                    reads.type === "ready"
                      ? new Set(columns.map((known) => known.id))
                      : null,
                  shownIds,
                }),
              );
              setAddedIds((current) => new Set([...current, ...columnIds]));
              announceAdded(columnIds);
            },
            addedIds,
            grants: { ...grants, run: grants.run && canRun },
            ...(reads.type === "ready" && reads.notice !== undefined
              ? { readNotice: reads.notice }
              : {}),
            isRunning: run.isPending,
            onColumnAction,
            onRetryAnswer: (column, decisionId) => {
              if (!canRun) {
                return;
              }
              detached(
                run.mutateAsync({
                  force: true,
                  runSet: {
                    columnIds: [column.id],
                    decisionIds: [decisionId],
                    cells: 1,
                  },
                }),
                "case-law-questions.retry-answer",
              );
            },
            onShowPassage,
            suggestion: { ...search, decisionIds: pageDecisionIds },
          }),
    editing,
    onEditingChange: setEditing,
    pendingRun,
    onCancelRun: () => setPendingRun(null),
    onConfirmRun: () => {
      if (pendingRun === null || !canRun) {
        return;
      }
      detached(
        run.mutateAsync({ force: pendingRun.force, runSet: pendingRun.runSet }),
        "case-law-questions.run",
      );
    },
    removing,
    onCancelRemove: () => setRemoving(null),
    onConfirmRemove: () => {
      if (removing === null) {
        return;
      }
      detached(
        remove.mutateAsync(removing.id),
        "case-law-questions.delete-column",
      );
    },
  };
};

/**
 * The toolbar half of the controller: adding a question, answering the page,
 * and the dialogs those flows and the column headers share.
 *
 * A surface with nothing to ask of draws nothing; a reader without an
 * organization gets the add-question trigger alone, because there is no column
 * of theirs to answer or edit yet.
 */
const QuestionReadError = ({ retry }: { retry: () => Promise<unknown> }) => {
  const t = useTranslations();
  return (
    <div
      role="alert"
      className="text-muted-foreground flex items-center gap-2 text-xs"
    >
      {t("common.somethingWentWrong")}
      <Button
        onClick={() => detached(retry(), "case-law-questions.retry-read")}
        size="sm"
        variant="ghost"
      >
        {t("common.retry")}
      </Button>
    </div>
  );
};

export const QuestionColumnSelectionBar = ({
  surface,
}: {
  surface: QuestionColumnSurface;
}) => {
  if (
    surface.type !== "available" ||
    !surface.grants.run ||
    surface.columns.length === 0
  ) {
    return null;
  }
  const scope = aiColumnRunScope({
    pageRowIds: surface.pageDecisionIds,
    selectedRowIds: surface.selectedDecisionIds,
  });
  if (scope.type !== "selection") {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <AiColumnSelectionAction
        columns={surface.columns.length}
        rows={scope.count}
        disabled={surface.isRunning}
        onRun={surface.onRunSelectedRows}
      />
    </div>
  );
};

export const QuestionColumnControls = ({
  controller,
}: {
  controller: QuestionColumnsController;
}) => {
  const t = useTranslations();
  const { editing, pendingRun, removing, surface } = controller;

  switch (surface.type) {
    case "pending":
      return (
        <div role="status" aria-label={t("common.loading")}>
          <Skeleton className="h-7 w-32" />
        </div>
      );
    case "error":
      return <QuestionReadError retry={surface.retry} />;
    case "hidden":
    case "gated":
      return <AddQuestionColumn surface={surface} triggerVariant="labelled" />;
    case "available":
      break;
    default:
      surface satisfies never;
      return panic("Unhandled question controls state");
  }

  return (
    <>
      {surface.readNotice !== undefined && (
        <QuestionReadError retry={surface.readNotice.retry} />
      )}
      <AddQuestionColumn surface={surface} triggerVariant="labelled" />

      {editing !== null && (
        <BulkAddColumns
          // A new dialog per question, so the fields start from what is being
          // edited rather than from whatever was typed last.
          key={editing.id}
          onOpenChange={(open) => {
            if (!open) {
              controller.onEditingChange(null);
            }
          }}
          open
          target={{
            kind: "organisation",
            mode: { type: "edit", column: editing },
            suggestion: surface.suggestion,
          }}
          triggerVariant="none"
        />
      )}

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            controller.onCancelRun();
          }
        }}
        open={pendingRun !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("caseLaw.research.runTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRun === null
                ? ""
                : t("caseLaw.research.runEstimate", {
                    cells: pendingRun.runSet.cells,
                    columns: pendingRun.runSet.columnIds.length,
                    rows: pendingRun.runSet.decisionIds.length,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              disabled={surface.isRunning || !surface.grants.run}
              onClick={controller.onConfirmRun}
            >
              {t("caseLaw.research.runConfirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            controller.onCancelRemove();
          }
        }}
        open={removing !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("workspaces.properties.deleteProperty")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("caseLaw.research.deleteColumnConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button onClick={controller.onConfirmRemove} variant="destructive">
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};
