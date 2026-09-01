import { useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { CaseLawResearchDisposition } from "@stll/api-contract";
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
  researchTableKeys,
  researchTableOptions,
  savedQueryToDecisionFilters,
} from "@/features/case-law/research/queries";
import type { ResearchTableDetail } from "@/features/case-law/research/queries";
import { ResearchTableView } from "@/features/case-law/research/research-table-view";
import { mergeResearchRows } from "@/features/case-law/research/row-model";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { parseDeterministicDate } from "@/lib/deterministic-date";
import { unwrapEden } from "@/lib/errors/api";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  ensureRouteInfiniteQueryData,
  ensureRouteQueryData,
} from "@/lib/react-query";
import { toSafeId } from "@/lib/safe-id";
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
  head: ({ loaderData }) => ({
    meta: [
      { title: pageTitleLiteral(loaderData?.name ?? "") },
      { name: "robots", content: "noindex" },
    ],
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

  const [groupBy, setGroupBy] = useState<DecisionGroupBy>("none");
  const [visibleColumns, setVisibleColumns] = useState<
    ReadonlySet<DecisionColumnId>
  >(defaultVisibleColumns);
  const [showExcluded, setShowExcluded] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

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
      unwrapEden(
        await api.case
          .research({ tableId: toSafeId<"caseLawResearchTable">(tableId) })
          .patch({ name }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: researchTableKeys.all });
    },
    onError: reportError,
  });

  const setDisposition = useMutation({
    mutationFn: async ({
      decision,
      disposition,
    }: {
      decision: Decision;
      disposition: CaseLawResearchDisposition | null;
    }) => {
      const table = api.case.research({
        tableId: toSafeId<"caseLawResearchTable">(tableId),
      });
      const decisionId = toSafeId<"caseLawDecision">(decision.id);
      return disposition === null
        ? unwrapEden(await table.decisions({ decisionId }).delete())
        : unwrapEden(await table.decisions.put({ decisionId, disposition }));
    },
    onSuccess: invalidateTable,
    onError: reportError,
  });

  const remove = useMutation({
    mutationFn: async () =>
      unwrapEden(
        await api.case
          .research({ tableId: toSafeId<"caseLawResearchTable">(tableId) })
          .delete(),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: researchTableKeys.all });
      await navigate({ to: "/law/cases/research" });
    },
    onError: reportError,
  });

  const queryRows: Decision[] = decisionsQuery.data
    ? decisionsQuery.data.pages.flatMap((page) => page.decisions)
    : [];
  const rows = mergeResearchRows({
    dispositions: detail.decisions,
    pinnedDecisions: detail.pinnedDecisions,
    queryRows,
    showExcluded,
  });
  const excludedCount = detail.decisions.filter(
    (entry) => entry.disposition === "excluded",
  ).length;

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <TableNameField
            name={detail.table.name}
            onRename={(name) => {
              detached(rename.mutateAsync(name), "case-law.research.rename");
            }}
          />
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
            if (value !== null && isDecisionGroupBy(value)) {
              setGroupBy(value);
            }
          }}
          value={groupBy}
        >
          <SelectTrigger
            aria-label={t("caseLaw.research.groupBy")}
            className="h-8 w-44 text-xs"
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
          </SelectPopup>
        </Select>

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
        groupBy={groupBy}
        isLoading={decisionsQuery.isLoading}
        onSetDisposition={(decision, disposition) => {
          detached(
            setDisposition.mutateAsync({ decision, disposition }),
            "case-law.research.set-disposition",
          );
        }}
        rows={rows}
        visibleColumns={visibleColumns}
      />

      {decisionsQuery.hasNextPage && (
        <div className="flex justify-center py-4">
          <Button
            disabled={decisionsQuery.isFetchingNextPage}
            onClick={() => {
              detached(
                decisionsQuery.fetchNextPage(),
                "case-law.research.fetch-next-page",
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
                detached(remove.mutateAsync(), "case-law.research.delete");
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
 * focus and hands it back on blur or Enter; the server value wins otherwise.
 */
function TableNameField({
  name,
  onRename,
}: {
  name: string;
  onRename: (name: string) => void;
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
      onRename(trimmed);
    }
  };

  return (
    <Input
      aria-label={t("common.name")}
      className="hover:border-input focus-visible:border-input h-9 max-w-xl border-transparent bg-transparent px-1 text-lg font-semibold shadow-none"
      maxLength={256}
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
