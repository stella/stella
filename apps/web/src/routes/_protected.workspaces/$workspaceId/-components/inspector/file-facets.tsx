import { useEffect, useMemo, useRef } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
import { usePulse } from "@/hooks/use-pulse";
import { DOCX_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import type { FileTab } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { entityVersionsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";

export type Facet = NonNullable<FileTab["facet"]>;

type FacetBarProps = {
  facet: Facet;
  facets: readonly Facet[];
  /**
   * Facets rendered but not interactive. Used for the AI
   * suggestions chip when the document hasn't received any AI
   * proposals yet — the chip stays visible (so users can find it)
   * but clicking does nothing until there's something to review.
   */
  disabledFacets?: ReadonlySet<Facet> | undefined;
  pulseSeq?: number | undefined;
  /**
   * Suffix appended to the active facet's label, e.g. `"v1"` →
   * "Preview (v1)". Hidden on inactive chips so the row stays
   * scannable. Omit when no version is meaningful.
   */
  activeBadge?: string | undefined;
  onChange: (next: Facet) => void;
};

// Sidepeek shows every facet, including Preview (the file viewer
// itself). Fullscreen drops Preview entirely — the main view IS
// the preview, so a duplicate chip would be confusing; the
// FullViewPreviewGuard handles users who land in Full view with a
// stale "preview" facet by swapping to Metadata + flashing the
// Minimize button.
export const FACETS: readonly Facet[] = [
  "preview",
  "metadata",
  "versions",
  "suggestions",
  "anonymization",
];
export const FULLVIEW_FACETS: readonly Facet[] = [
  "metadata",
  "versions",
  "suggestions",
  "anonymization",
];

/**
 * Mounted only inside the fullscreen branch. If the user enters Full
 * view while their tab still holds `facet: "preview"` (carried over
 * from sidepeek), silently swap to Metadata, drop a one-line toast,
 * and pulse the header's Minimize button so they know that's how to
 * get a side-by-side preview again.
 */
type FullViewPreviewGuardProps = {
  tabId: string;
  facet: FileTab["facet"];
  setFileFacet: (tabId: string, facet: NonNullable<FileTab["facet"]>) => void;
  flashMinimize: (tabId: string) => void;
};

export const FullViewPreviewGuard = ({
  tabId,
  facet,
  setFileFacet,
  flashMinimize,
}: FullViewPreviewGuardProps) => {
  const t = useTranslations();
  useEffect(() => {
    if (facet !== "preview") {
      return;
    }
    setFileFacet(tabId, "metadata");
    stellaToast.info(t("inspector.facet.previewInFullViewToast"));
    flashMinimize(tabId);
  }, [facet, tabId, setFileFacet, flashMinimize, t]);
  return null;
};

const FacetBar = ({
  facet,
  facets,
  disabledFacets,
  pulseSeq,
  activeBadge,
  onChange,
}: FacetBarProps) => {
  const t = useTranslations();
  const { isPulsing: pulsing, pulse } = usePulse(1400);
  const lastPulseSeq = useRef<number | undefined>(pulseSeq);

  useEffect(() => {
    if (pulseSeq === undefined || pulseSeq === lastPulseSeq.current) {
      return;
    }
    lastPulseSeq.current = pulseSeq;
    pulse();
  }, [pulseSeq, pulse]);

  const labels: Record<Facet, string> = {
    preview: t("inspector.facet.preview"),
    metadata: t("common.metadata"),
    versions: t("fileDetail.versionHistory"),
    suggestions: t("docxReview.title"),
    anonymization: t("inspector.facet.anonymization"),
  };

  return (
    <div
      className={cn(
        // `whitespace-nowrap` on each chip stops multi-word
        // labels like "Historie verzí" from breaking mid-row
        // in narrow inspector panes. The row stays single
        // line; the active version chip moved to the chip's
        // tooltip / sibling chrome (no longer inline) so the
        // strip fits without horizontal scroll.
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
              // Active chip never shrinks — its full label
              // always reads. Inactive chips can shrink and
              // ellipsis if the row gets tight (full label
              // is still in the `title` tooltip).
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

/**
 * Per-tab wrapper around `FacetBar`. Three jobs:
 *  - Resolve the active version label ("v1", "v3", …) for the
 *    current field id and feed it as `activeBadge`.
 *  - Hide the AI-suggestions chip on tabs where the chat can't
 *    produce one (PDFs, files without DOCX-edit support).
 *  - Mark the AI-suggestions chip as inactive on DOCX tabs that
 *    haven't received any AI proposals yet, so the affordance is
 *    visible without inviting clicks that would land on an empty
 *    panel.
 *
 * Lives as its own component so the version + review-store reads
 * stay scoped per tab — no conditional hooks inside the parent's
 * pdfTabs.map.
 */
type TabFacetBarProps = Omit<
  FacetBarProps,
  "activeBadge" | "facets" | "disabledFacets"
> & {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  mimeType: string | undefined;
  /**
   * Base list before this component drops/disables the
   * suggestions chip. Sidepeek passes the full list (preview,
   * metadata, versions, suggestions); fullscreen passes the
   * preview-less variant.
   */
  baseFacets: readonly Facet[];
};

export const TabFacetBar = ({
  workspaceId,
  entityId,
  fieldId,
  mimeType,
  baseFacets,
  ...rest
}: TabFacetBarProps) => {
  const { data } = useQuery(entityVersionsOptions({ workspaceId, entityId }));
  const version = data?.versions.find((v) => v.file?.fieldId === fieldId);
  const activeBadge = version ? `v${String(version.versionNumber)}` : undefined;
  const suggestionCount = useReviewStore(
    (state) => state.sessions[entityId]?.length ?? 0,
  );
  const isDocx = mimeType === DOCX_MIME;

  const { facets, disabledFacets } = useMemo(() => {
    if (!isDocx) {
      return {
        facets: baseFacets.filter((f) => f !== "suggestions"),
        disabledFacets: undefined,
      };
    }
    if (suggestionCount === 0) {
      return {
        facets: baseFacets,
        disabledFacets: new Set<Facet>(["suggestions"]),
      };
    }
    return { facets: baseFacets, disabledFacets: undefined };
  }, [baseFacets, isDocx, suggestionCount]);

  return (
    <FacetBar
      activeBadge={activeBadge}
      disabledFacets={disabledFacets}
      facets={facets}
      {...rest}
    />
  );
};

export const MetadataPanelSkeleton = () => (
  <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-col gap-px p-2">
      {[0, 1, 2, 3].map((i) => (
        <div className="flex flex-col gap-1.5 px-2 py-2" key={i}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-4 w-full" />
        </div>
      ))}
    </div>
  </div>
);
