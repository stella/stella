/**
 * The Graph view of a list: the documents verified against it, their
 * claims, the list's facts and where those come from, linked as the review
 * links them. Read-only: a claim opens the review's own claim panel, a
 * source opens its document at the place the fact cites.
 */

import * as React from "react";

import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { FilterXIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Skeleton } from "@stll/ui/skeleton";
import { Switch } from "@stll/ui/switch";
import { useIsMobile } from "@stll/ui/use-mobile";
import { cn } from "@stll/ui/utils";

import {
  GraphCanvas,
  TIER_LABEL_KEYS,
} from "@/features/avt/graph/graph-canvas";
import type { OpenedClaim } from "@/features/avt/graph/graph-claim-sheet";
import {
  GraphClaimPane,
  GraphClaimSheet,
} from "@/features/avt/graph/graph-claim-sheet";
import { GraphList } from "@/features/avt/graph/graph-list";
import type {
  GraphFilters,
  GraphModel,
  GraphNodeRef,
  TierFilter,
  VerdictFilter,
} from "@/features/avt/graph/graph-model.logic";
import {
  DEFAULT_GRAPH_FILTERS,
  filterGraph,
  isFiltered,
  layoutGraph,
  mergeGraphPages,
  neighbourhoodOf,
  nodeKey,
} from "@/features/avt/graph/graph-model.logic";
import { useScrollViewport } from "@/features/avt/graph/use-scroll-viewport";
import { avtKeys, verificationGraphOptions } from "@/features/avt/queries";
import type { ClaimState } from "@/features/avt/types";
import { STATE_META } from "@/features/avt/types";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";

type VerificationGraphProps = {
  workspaceId: string;
  listId: string;
  /** Switches the view back to the review, where documents are verified. */
  onReview: () => void;
};

/** The graph and the chronology read one query; this is its shared state. */
export const useVerificationGraphModel = ({
  workspaceId,
  listId,
}: {
  workspaceId: string;
  listId: string;
}) => {
  const query = useInfiniteQuery(
    verificationGraphOptions({ workspaceId, listId }),
  );
  const model =
    query.data === undefined ? null : mergeGraphPages(query.data.pages);
  return { query, model };
};

/** The claim panel over a graph view: closing it re-reads the graph, so a
 *  decision taken in it shows at once. */
export const useOpenedClaim = (workspaceId: string) => {
  const queryClient = useQueryClient();
  const [opened, setOpened] = React.useState<OpenedClaim | null>(null);
  return {
    opened,
    open: (claim: { statementId: string; id: string }) =>
      setOpened({ runId: claim.statementId, claimId: claim.id }),
    close: () => {
      setOpened(null);
      detached(
        queryClient.invalidateQueries({
          queryKey: avtKeys.graphAll(workspaceId),
        }),
        "avt-graph.refresh-after-claim",
      );
    },
  };
};

export const VerificationGraph = ({
  workspaceId,
  listId,
  onReview,
}: VerificationGraphProps) => {
  const t = useTranslations();
  const { query, model } = useVerificationGraphModel({ workspaceId, listId });
  const claimPanel = useOpenedClaim(workspaceId);

  if (query.isPending) {
    return <GraphSkeleton />;
  }
  if (model === null) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="text-muted-foreground">{t("common.loadFailed")}</span>
        <Button
          onClick={() => detached(query.refetch(), "avt-graph.reload")}
          size="sm"
          variant="outline"
        >
          {t("common.reload")}
        </Button>
      </div>
    );
  }
  if (model.statements.length === 0 && model.facts.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-muted-foreground">{t("avt.graph.empty")}</span>
        <Button onClick={onReview} size="sm" variant="outline">
          {t("avt.graph.verifyInReview")}
        </Button>
      </div>
    );
  }
  return (
    <GraphBody
      hasMore={query.hasNextPage}
      loadingMore={query.isFetchingNextPage}
      model={model}
      onLoadMore={() => detached(query.fetchNextPage(), "avt-graph.load-more")}
      onCloseClaim={claimPanel.close}
      onOpenClaim={claimPanel.open}
      onReview={onReview}
      opened={claimPanel.opened}
      workspaceId={workspaceId}
    />
  );
};

type GraphBodyProps = {
  workspaceId: string;
  model: GraphModel;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onOpenClaim: (claim: { statementId: string; id: string }) => void;
  onReview: () => void;
  /** The claim whose panel is open, docked beside the canvas on a wide
   *  screen and in a sheet on a narrow one. */
  opened: OpenedClaim | null;
  onCloseClaim: () => void;
};

const GraphBody = ({
  workspaceId,
  model,
  hasMore,
  loadingMore,
  onLoadMore,
  onOpenClaim,
  onReview,
  opened,
  onCloseClaim,
}: GraphBodyProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const isMobile = useIsMobile();
  const [filters, setFilters] = React.useState<GraphFilters>(
    DEFAULT_GRAPH_FILTERS,
  );
  const [focus, setFocus] = React.useState<GraphNodeRef | null>(null);
  const [viewportRef, viewport] = useScrollViewport();

  const shown = filterGraph(model, filters);
  const layout = layoutGraph(shown);
  // A focus the filters took away is dropped rather than dimming everything.
  const activeFocus =
    focus !== null && layout.boxes.has(nodeKey(focus)) ? focus : null;
  const neighbourhood =
    activeFocus === null ? null : neighbourhoodOf(shown, activeFocus);

  const onNode = (ref: GraphNodeRef) => {
    switch (ref.kind) {
      case "claim": {
        setFocus(ref);
        const claim = shown.claims.find((item) => item.id === ref.id);
        if (claim !== undefined) {
          onOpenClaim(claim);
        }
        return;
      }
      case "statement":
      case "fact":
      case "source": {
        setFocus(
          activeFocus !== null &&
            activeFocus.kind === ref.kind &&
            activeFocus.id === ref.id
            ? null
            : ref,
        );
        return;
      }
      default: {
        ref.kind satisfies never;
        panic(`Unhandled graph node: ${String(ref.kind)}`);
      }
    }
  };

  const nothingShown =
    shown.statements.length === 0 && shown.facts.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <GraphFilterBar filters={filters} onChange={setFilters} />
      {model.statements.length === 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {t("avt.graph.noStatements")}
          </span>
          <Button onClick={onReview} size="sm" variant="ghost">
            {t("avt.graph.verifyInReview")}
          </Button>
        </div>
      )}
      {nothingShown && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            {t("avt.graph.noMatch")}
          </span>
          <Button
            onClick={() => setFilters(DEFAULT_GRAPH_FILTERS)}
            size="sm"
            variant="ghost"
          >
            <FilterXIcon />
            {t("common.clearFilters")}
          </Button>
        </div>
      )}
      {!nothingShown && isMobile && (
        <>
          <GraphList
            model={shown}
            onOpenClaim={onOpenClaim}
            workspaceId={workspaceId}
          />
          <GraphClaimSheet
            onClose={onCloseClaim}
            opened={opened}
            workspaceId={workspaceId}
          />
        </>
      )}
      {!nothingShown && !isMobile && (
        <>
          <div className="flex items-start gap-3">
            <div className="bg-background min-w-0 flex-1 overflow-hidden rounded-xl border">
              <ScrollArea
                className="max-h-[calc(100dvh-13rem)] min-h-64"
                viewportRef={viewportRef}
              >
                <div className="p-3">
                  <GraphCanvas
                    focus={activeFocus}
                    layout={layout}
                    model={shown}
                    neighbourhood={neighbourhood}
                    onNode={onNode}
                    viewport={
                      viewport.height === 0
                        ? null
                        : { top: viewport.top, height: viewport.height }
                    }
                    width={Math.max(0, viewport.width - FRAME_PADDING)}
                  />
                </div>
              </ScrollArea>
            </div>
            {opened !== null && (
              <GraphClaimPane
                onClose={onCloseClaim}
                opened={opened}
                workspaceId={workspaceId}
              />
            )}
          </div>
          {/* The same graph for the keyboard and screen readers; shown when
              focus moves into it. */}
          <GraphList
            className="sr-only focus-within:not-sr-only"
            model={shown}
            onOpenClaim={onOpenClaim}
            workspaceId={workspaceId}
          />
        </>
      )}
      {(hasMore || model.factOverflow) && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
          {model.factOverflow && (
            <span>
              {t("avt.graph.factOverflow", {
                count: format.number(model.facts.length),
              })}
            </span>
          )}
          {hasMore && (
            <Button
              loading={loadingMore}
              onClick={onLoadMore}
              size="sm"
              variant="outline"
            >
              {t("avt.graph.loadMore")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};

/** The frame's padding on both sides, which the canvas does not draw in. */
const FRAME_PADDING = 24;

const isClaimState = (value: string): value is ClaimState =>
  Object.hasOwn(STATE_META, value);

/** The verdicts the filter offers, in the order the review defines them. */
const VERDICT_OPTIONS = Object.keys(STATE_META).filter(isClaimState);

const ALL = "all";
const ANY = "any";

const isVerdictFilter = (value: string): value is VerdictFilter =>
  value === ALL || value === "conflicts" || isClaimState(value);

/** The source filter names a footing as the review does. */
const SOURCE_FILTER_LABEL_KEYS = {
  document: "common.documents",
  ...TIER_LABEL_KEYS,
} as const;

const isTierFilter = (value: string): value is TierFilter =>
  value === ANY || Object.hasOwn(SOURCE_FILTER_LABEL_KEYS, value);

type GraphFilterBarProps = {
  filters: GraphFilters;
  onChange: (next: GraphFilters) => void;
};

/** One quiet row: the verdict (all, the conflicts, no coverage, or one
 *  verdict), the footing, and whether held facts are drawn. */
const GraphFilterBar = ({ filters, onChange }: GraphFilterBarProps) => {
  const t = useTranslations();
  const set = (patch: Partial<GraphFilters>) =>
    onChange({ ...filters, ...patch });
  return (
    <div
      aria-label={t("common.filters")}
      className="flex flex-wrap items-center gap-x-3 gap-y-2"
      data-testid="avt-graph-filters"
      role="group"
    >
      <Select
        onValueChange={(value) => {
          if (value !== null && isVerdictFilter(value)) {
            set({ verdict: value });
          }
        }}
        value={filters.verdict}
      >
        <SelectTrigger
          aria-label={t("avt.graph.filters.verdict")}
          className="w-auto min-w-36"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={ALL}>
            {t("avt.graph.filters.allVerdicts")}
          </SelectItem>
          <SelectItem value="conflicts">
            {t("avt.graph.filters.conflicts")}
          </SelectItem>
          <SelectItem value="nocover">
            {t(STATE_META.nocover.chipKey)}
          </SelectItem>
          {VERDICT_OPTIONS.filter((state) => state !== "nocover").map(
            (state) => (
              <SelectItem key={state} value={state}>
                {t(STATE_META[state].chipKey)}
              </SelectItem>
            ),
          )}
        </SelectPopup>
      </Select>
      <Select
        onValueChange={(value) => {
          if (value !== null && isTierFilter(value)) {
            set({ tier: value });
          }
        }}
        value={filters.tier}
      >
        <SelectTrigger
          aria-label={t("avt.graph.filters.source")}
          className="w-auto min-w-32"
          size="sm"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={ANY}>
            {t("avt.graph.filters.allSources")}
          </SelectItem>
          <SelectItem value="document">
            {t(SOURCE_FILTER_LABEL_KEYS.document)}
          </SelectItem>
          <SelectItem value="testimony">
            {t("avt.factTier.testimony.label")}
          </SelectItem>
          <SelectItem value="unsourced">
            {t("avt.factTier.unsourced.label")}
          </SelectItem>
        </SelectPopup>
      </Select>
      <Label variant="choice">
        {/* The switch is not a labelable element, so the label's text
            does not name it on its own. */}
        <Switch
          aria-label={t("avt.graph.filters.heldFacts")}
          checked={filters.showHeld}
          onCheckedChange={(showHeld) => set({ showHeld })}
          size="sm"
        />
        {t("avt.graph.filters.heldFacts")}
      </Label>
      {isFiltered(filters) && (
        <Button
          onClick={() => onChange(DEFAULT_GRAPH_FILTERS)}
          size="sm"
          variant="ghost"
        >
          <FilterXIcon />
          {t("common.clearFilters")}
        </Button>
      )}
    </div>
  );
};

const SKELETON_ROWS = ["a", "b", "c", "d", "e"];

/** The canvas's four columns, shimmering until the graph is read. */
const GraphSkeleton = () => (
  <div className="flex flex-col gap-3">
    <div className="flex gap-1.5">
      <Skeleton className="h-8 w-36" />
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-8 w-28" />
    </div>
    <div
      className={cn(
        "grid min-h-64 grid-cols-[17fr_31fr_33fr_19fr] gap-16 rounded-xl border p-3",
        "max-md:grid-cols-1 max-md:gap-2",
      )}
    >
      {["statement", "claim", "fact", "source"].map((column) => (
        <div className="flex flex-col gap-2" key={column}>
          {SKELETON_ROWS.map((row) => (
            <Skeleton className="h-12 w-full" key={row} />
          ))}
        </div>
      ))}
    </div>
  </div>
);
