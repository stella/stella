import { useEffect, useRef } from "react";

import { cn } from "@stll/ui/lib/utils";

import { usePulse } from "@/hooks/use-pulse";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";

type FacetBarProps<F extends string> = {
  facet: F;
  facets: readonly F[];
  /** Display label per facet. */
  labels: Record<F, string>;
  /**
   * Facets rendered but not interactive — visible so users can find
   * them, but clicking does nothing (e.g. an AI-suggestions chip
   * before any proposals exist).
   */
  disabledFacets?: ReadonlySet<F> | undefined;
  pulseSeq?: number | undefined;
  /**
   * Suffix appended to the active facet's label, e.g. `"v1"` →
   * "Preview · v1". Hidden on inactive chips so the row stays
   * scannable.
   */
  activeBadge?: string | undefined;
  onChange: (next: F) => void;
};

/**
 * Inspector subtab row: a single line of pill chips at toolbar-row
 * height. Presentational and facet-agnostic — every inspector tab
 * type (file-viewer facets, template-studio fields/clauses/history)
 * drives it with its own facet union + labels so the row reads
 * identically across the inspector.
 */
export const FacetBar = <F extends string>({
  facet,
  facets,
  labels,
  disabledFacets,
  pulseSeq,
  activeBadge,
  onChange,
}: FacetBarProps<F>) => {
  const { isPulsing: pulsing, pulse } = usePulse(1400);
  const lastPulseSeq = useRef<number | undefined>(pulseSeq);

  useEffect(() => {
    if (pulseSeq === undefined || pulseSeq === lastPulseSeq.current) {
      return;
    }
    lastPulseSeq.current = pulseSeq;
    pulse();
  }, [pulseSeq, pulse]);

  return (
    <div
      className={cn(
        // `whitespace-nowrap` on each chip stops multi-word labels
        // from breaking mid-row in narrow inspector panes.
        "bg-background/85 supports-[backdrop-filter]:bg-background/65 sticky top-0 z-10 flex shrink-0 items-center gap-0.5 border-b px-1.5 backdrop-blur",
        TOOLBAR_ROW_HEIGHT,
      )}
    >
      {facets.map((value) => {
        const active = value === facet;
        const disabled = disabledFacets?.has(value) ?? false;
        return (
          <button
            className={cn(
              // Active chip never shrinks — its full label always
              // reads. Inactive chips can shrink and ellipsis if the
              // row gets tight (full label is still in `title`).
              "min-w-0 truncate rounded-md px-1.5 py-1 text-xs font-medium whitespace-nowrap transition-colors",
              active
                ? "bg-foreground text-background shrink-0"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
              active &&
                pulsing &&
                "ring-foreground-disabled animate-pulse ring-2",
              disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
            )}
            disabled={disabled}
            key={value}
            onClick={() => onChange(value)}
            title={
              active && activeBadge !== undefined
                ? `${labels[value]} · ${activeBadge}`
                : labels[value]
            }
            type="button"
          >
            {labels[value]}
          </button>
        );
      })}
    </div>
  );
};
