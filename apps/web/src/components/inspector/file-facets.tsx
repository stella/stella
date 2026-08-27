import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { FacetBar } from "@/components/inspector/inspector-facet-bar";
import type {
  FileFacet,
  FileTab,
} from "@/components/inspector/inspector-store-types";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { DOCX_MIME, isEmailFile } from "@/lib/consts";
import { entityVersionsOptions } from "@/lib/workspaces/queries/entity-versions";

export type Facet = FileFacet;

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
  useExternalSyncEffect(() => {
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
 * Per-tab wrapper around the shared `FacetBar`. Two jobs:
 *  - Resolve the active version label ("v1", "v3", …) for the
 *    current field id and feed it as `activeBadge`.
 *  - Hide the document-review chip on tabs the review can't target
 *    (PDFs, files without DOCX-edit support).
 *
 * Lives as its own component so the version read stays scoped per
 * tab — no conditional hooks inside the parent's pdfTabs.map.
 */
type TabFacetBarProps = {
  facet: Facet;
  onChange: (next: Facet) => void;
  pulseSeq?: number | undefined;
  workspaceId: string;
  entityId: string;
  fieldId: string;
  fileName: string;
  mimeType: string | undefined;
  /**
   * Base list before this component drops the chips a tab cannot use.
   * Sidepeek passes the full list; fullscreen passes the preview-less
   * variant.
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
  fileName,
  mimeType,
  baseFacets,
}: TabFacetBarProps) => {
  const t = useTranslations();
  const { data } = useQuery(entityVersionsOptions({ workspaceId, entityId }));
  const version = data?.versions.find((v) => v.file?.fieldId === fieldId);
  const activeBadge = version ? `v${String(version.versionNumber)}` : undefined;
  const isDocx = mimeType === DOCX_MIME;
  const isEmail = isEmailFile({ fileName, mimeType });
  const facets = useMemo(
    () =>
      // The document-review surface is DOCX-only (it needs folio block ids to
      // target), so its chip is absent on every other tab. On DOCX it stays
      // enabled even before a run: it doubles as the launcher, and it is where
      // changes the chat proposed are listed.
      baseFacets.filter(
        (f) => (isDocx || f !== "playbook") && (isEmail || f !== "attachments"),
      ),
    [baseFacets, isDocx, isEmail],
  );

  const labels: Record<Facet, string> = {
    preview: t("common.preview"),
    attachments: t("emailViewer.attachments"),
    metadata: t("common.metadata"),
    versions: t("fileDetail.versionHistory"),
    playbook: t("inspector.review.title"),
    anonymization: t("inspector.facet.anonymization"),
  };

  return (
    <FacetBar
      activeBadge={activeBadge}
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
