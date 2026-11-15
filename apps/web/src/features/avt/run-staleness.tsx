/**
 * The run's one line about new evidence: how many claims may be out of date
 * (pressing it filters the document to them), the re-check of all of them,
 * and what that re-check is doing or did. Quiet by design: it shows only
 * while there is something to say.
 */

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  CheckIcon,
  HistoryIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  XIcon,
} from "@stll/ui/icons";
import { Loader } from "@stll/ui/loader";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";

import type { useBulkRecheck } from "@/features/avt/use-bulk-recheck";
import { detached } from "@/lib/detached";

type RunStalenessLineProps = {
  /** The claims out of date now, in reading order. */
  outOfDateIds: readonly string[];
  /** Whether the document is filtered to them. */
  filtered: boolean;
  canReview: boolean;
  recheck: ReturnType<typeof useBulkRecheck>;
  onFilter: (filtered: boolean) => void;
};

export const RunStalenessLine = ({
  outOfDateIds,
  filtered,
  canReview,
  recheck,
  onFilter,
}: RunStalenessLineProps) => {
  const t = useTranslations();
  const count = outOfDateIds.length;
  const bulk = recheck.state;
  const onToggleFilter = () => onFilter(!filtered);
  const onDismiss = recheck.dismiss;
  const onRecheck = (claimIds: readonly string[]) => {
    // The claims leave the filter as they are graded, so the document shows
    // every claim again while they are.
    if (filtered) {
      onFilter(false);
    }
    detached(recheck.start(claimIds), "avt.bulk-recheck");
  };

  if (bulk.type === "running") {
    return (
      <Line>
        <Loader className="size-3.5" size="sm" variant="decorative" />
        <span aria-live="polite" role="status">
          {t("avt.staleness.running", { count: bulk.remaining })}
        </span>
      </Line>
    );
  }

  if (bulk.type === "finished") {
    const failed = bulk.failures.length;
    // Asking again helps only where the server said it may; the reasons it
    // gave show on hover over the result.
    const retryIds = bulk.failures
      .filter((failure) => failure.retryable)
      .map((failure) => failure.claimId);
    const reasons = [
      ...new Set(
        bulk.failures.flatMap((failure) =>
          failure.message === null ? [] : [failure.message],
        ),
      ),
    ];
    const result = (
      <span aria-live="polite" className="min-w-0" role="status">
        {failed === 0
          ? t("avt.staleness.finished", { count: bulk.rechecked })
          : t("avt.staleness.partial", {
              rechecked: bulk.rechecked,
              failed,
            })}
        {/* The reasons a pointer shows on hover, read with the result. */}
        {reasons.length > 0 && (
          <span className="sr-only"> {reasons.join(" ")}</span>
        )}
      </span>
    );
    return (
      <Line>
        {failed === 0 ? (
          <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
        ) : (
          <TriangleAlertIcon
            aria-hidden="true"
            className="text-warning size-3.5 shrink-0"
          />
        )}
        {reasons.length === 0 ? (
          result
        ) : (
          <Tooltip>
            <TooltipTrigger render={<span className="min-w-0" />}>
              {result}
            </TooltipTrigger>
            <TooltipPopup>
              <ul className="space-y-0.5">
                {reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </TooltipPopup>
          </Tooltip>
        )}
        {retryIds.length > 0 && (
          <Button
            disabled={!canReview}
            onClick={() => onRecheck(retryIds)}
            size="sm"
            variant="ghost"
          >
            <RefreshCwIcon />
            {t("common.retry")}
          </Button>
        )}
        <Button
          aria-label={t("common.dismiss")}
          className="ms-auto"
          onClick={onDismiss}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </Line>
    );
  }

  if (count === 0) {
    return null;
  }
  return (
    <Line>
      <Button
        aria-pressed={filtered}
        onClick={onToggleFilter}
        selected={filtered}
        size="sm"
        variant="ghost"
      >
        <HistoryIcon />
        {t("avt.staleness.runLine", { count })}
      </Button>
      {/* Beside the count it acts on; quiet, so accepting routine claims
          stays the triage's one accent. */}
      <Button
        disabled={!canReview}
        onClick={() => onRecheck(outOfDateIds)}
        size="sm"
        variant="ghost"
      >
        {t("avt.staleness.recheckAll")}
      </Button>
    </Line>
  );
};

const Line = ({ children }: { children: React.ReactNode }) => (
  <div className="text-muted-foreground flex min-h-9 flex-wrap items-center gap-2 px-1 text-xs">
    {children}
  </div>
);
