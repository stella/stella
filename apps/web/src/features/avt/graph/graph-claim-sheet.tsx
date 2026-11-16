/**
 * The claim detail panel of the review, opened over the graph or the
 * chronology: the same component with the same run read, so a decision
 * taken here is the one the review shows.
 */

import * as React from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";
import { Sheet, SheetPopup, SheetTitle } from "@stll/ui/sheet";
import { Skeleton } from "@stll/ui/skeleton";

import { ClaimDetailPanel } from "@/features/avt/claim-detail-panel";
import { verificationRunOptions } from "@/features/avt/queries";
import { useBulkRecheck } from "@/features/avt/use-bulk-recheck";
import { useClaimReviewActions } from "@/features/avt/use-claim-review-actions";
import {
  claimFactsById,
  contestedFactIds,
  resolveClaimView,
} from "@/features/avt/verdict";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";

/** A claim opened from the graph: its run (the document's verification)
 *  and the claim. */
export type OpenedClaim = { runId: string; claimId: string };

type GraphClaimSheetProps = {
  workspaceId: string;
  opened: OpenedClaim | null;
  onClose: () => void;
};

export const GraphClaimSheet = ({
  workspaceId,
  opened,
  onClose,
}: GraphClaimSheetProps) => {
  const t = useTranslations();
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={opened !== null}
    >
      {opened !== null && (
        <SheetPopup className="max-w-xl" side="inline-end">
          <SheetTitle className="sr-only">
            {t("avt.graph.claimTitle")}
          </SheetTitle>
          <ClaimSheetBody
            claimId={opened.claimId}
            key={`${opened.runId}:${opened.claimId}`}
            runId={opened.runId}
            workspaceId={workspaceId}
          />
        </SheetPopup>
      )}
    </Sheet>
  );
};

type GraphClaimPaneProps = {
  workspaceId: string;
  opened: OpenedClaim;
  onClose: () => void;
};

/**
 * The claim panel docked beside the canvas on a wide screen: no backdrop,
 * so the focused neighbourhood stays in view and another claim can be
 * opened straight from the graph.
 */
export const GraphClaimPane = ({
  workspaceId,
  opened,
  onClose,
}: GraphClaimPaneProps) => {
  const t = useTranslations();
  // The panel takes focus when it opens, so the keyboard reaches its close
  // button and review controls next; it keeps it as another claim opens.
  const focusOnOpen = React.useCallback((element: HTMLElement | null) => {
    element?.focus({ preventScroll: true });
  }, []);
  return (
    <aside
      aria-label={t("avt.graph.claimTitle")}
      ref={focusOnOpen}
      tabIndex={-1}
      className="bg-background relative flex h-[calc(100dvh-13rem)] min-h-64 w-[min(26rem,40%)] shrink-0 flex-col overflow-hidden rounded-xl border"
      data-testid="avt-graph-claim-pane"
    >
      <Button
        aria-label={t("common.close")}
        className="absolute end-2 top-2 z-10"
        onClick={onClose}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon />
      </Button>
      <ClaimSheetBody
        claimId={opened.claimId}
        key={`${opened.runId}:${opened.claimId}`}
        runId={opened.runId}
        workspaceId={workspaceId}
      />
    </aside>
  );
};

type ClaimSheetBodyProps = {
  workspaceId: string;
  runId: string;
  claimId: string;
};

const ClaimSheetBody = ({
  workspaceId,
  runId,
  claimId,
}: ClaimSheetBodyProps) => {
  const t = useTranslations();
  const runQuery = useQuery(verificationRunOptions(workspaceId, runId));
  const runView = queryView(runQuery);
  useQueryViewError(runView, "GraphClaimSheet:run");
  const { recordEvent } = useClaimReviewActions({ workspaceId, runId });
  const recheck = useBulkRecheck({ workspaceId, runId });

  if (runView.type === "pending") {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (runView.type !== "items") {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        {t("common.loadFailed")}
      </p>
    );
  }
  const run = runView.items;
  const stored = run.claims.find((claim) => claim.id === claimId);
  if (stored === undefined) {
    return (
      <p className="text-muted-foreground p-4 text-sm">
        {t("common.loadFailed")}
      </p>
    );
  }
  const claim = resolveClaimView(stored);
  return (
    <div className="min-h-0 flex-1">
      <ClaimDetailPanel
        claim={claim}
        contested={contestedFactIds(run.evidence.facts)}
        factsById={claimFactsById(run, claim)}
        onReviewEvent={(event) => recordEvent(claim.id, event)}
        recheckRun={recheck.forClaim(claim.id)}
        run={run}
        workspaceId={workspaceId}
      />
    </div>
  );
};
