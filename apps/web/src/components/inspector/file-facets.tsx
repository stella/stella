import { useEffect, useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { useReviewStore } from "@/components/ai-suggestions/review-store";
import { FacetBar } from "@/components/inspector/inspector-facet-bar";
import type { FileTab } from "@/components/inspector/inspector-store";
import { DOCX_MIME } from "@/lib/consts";
import { entityVersionsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/entity-versions";

export type Facet = NonNullable<FileTab["facet"]>;

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

/**
 * Per-tab wrapper around the shared `FacetBar`. Three jobs:
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
type TabFacetBarProps = {
  facet: Facet;
  onChange: (next: Facet) => void;
  pulseSeq?: number | undefined;
  workspaceId: string;
  entityId: string;
  fieldId: string;
  mimeType: string | undefined;
  /**
   * Base list before this component drops/disables the suggestions
   * chip. Sidepeek passes the full list (preview, metadata, versions,
   * suggestions); fullscreen passes the preview-less variant.
   */
  baseFacets: readonly Facet[];
};

export const TabFacetBar = ({
  facet,
  onChange,
  pulseSeq,
  workspaceId,
  entityId,
  fieldId,
  mimeType,
  baseFacets,
}: TabFacetBarProps) => {
  const t = useTranslations();
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

  const labels: Record<Facet, string> = {
    preview: t("common.preview"),
    metadata: t("common.metadata"),
    versions: t("fileDetail.versionHistory"),
    suggestions: t("docxReview.title"),
    anonymization: t("inspector.facet.anonymization"),
  };

  return (
    <FacetBar
      activeBadge={activeBadge}
      disabledFacets={disabledFacets}
      facet={facet}
      facets={facets}
      labels={labels}
      onChange={onChange}
      pulseSeq={pulseSeq}
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
