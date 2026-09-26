import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import {
  FullViewPreviewGuard,
  TabFacetBar,
} from "@/components/inspector/file-facets";
import type { Facet } from "@/components/inspector/file-facets";
import {
  FACETS,
  FULLVIEW_FACETS,
} from "@/components/inspector/file-tab-panel.logic";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import type { FileTab } from "@/components/inspector/inspector-tabs-store";

type FileTabFullViewProps = {
  facet: Facet;
  /** The non-preview facets, rendered for `facet`. */
  facetContent: ReactNode;
  header: ReactNode;
  isActive: boolean;
  onFacetChange: (facet: Facet) => void;
  /** The route's main pane shows the review, so this tab reads the document. */
  readsDocumentInInspector: boolean;
  tab: FileTab;
  viewer: ReactNode;
};

/**
 * "Expanded" persona: the route already renders the file in its main content
 * (full folio), so the inspector tab drops the file chrome (zoom, file viewer)
 * and shows itself as a metadata panel — same tab state, different rendering.
 */
export const FileTabFullView = ({
  facet,
  facetContent,
  header,
  isActive,
  onFacetChange,
  readsDocumentInInspector,
  tab,
  viewer,
}: FileTabFullViewProps) => {
  const setFileFacet = useInspectorTabsStore((s) => s.setFileFacet);
  return (
    <div
      className={cn(
        "bg-background flex flex-1 flex-col overflow-hidden",
        !isActive && "hidden",
      )}
    >
      {/* The guard exists because the main view is normally the preview.
          When the route has handed that pane to the review, it is not, and
          the preview belongs here. */}
      {!readsDocumentInInspector && (
        <FullViewPreviewGuard
          facet={tab.facet}
          setFileFacet={setFileFacet}
          tabId={tab.id}
        />
      )}
      {header}
      <TabFacetBar
        // Preview is intentionally absent in fullscreen — the
        // main view IS the preview. If the user enters Full
        // view with Preview active in sidepeek, the
        // FullViewPreviewGuard above swaps to Metadata and
        // pulses the Minimize button so they know how to get
        // a side-by-side view back. The exception is the swapped
        // arrangement, where this panel is the only place the
        // document can be read.
        baseFacets={readsDocumentInInspector ? FACETS : FULLVIEW_FACETS}
        entityId={tab.entityId}
        facet={facet}
        fieldId={tab.id}
        fileName={tab.fileName}
        mimeType={tab.mimeType}
        onChange={onFacetChange}
        pulseSeq={tab.facetPulseSeq}
        workspaceId={tab.workspaceId}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        {/* The document itself, when the main pane is showing the review
            instead. Same viewer the sidepeek persona mounts, so the block
            scroll a finding requests lands in it unchanged. */}
        {readsDocumentInInspector && facet === "preview" && (
          <div className="flex min-h-0 min-w-0 flex-1">{viewer}</div>
        )}
        {facetContent}
        {/* Without the swap there is no preview branch here: the main
         *  view IS the preview, and FullViewPreviewGuard above moves a
         *  stale "preview" facet to "metadata" on entry. */}
      </div>
    </div>
  );
};
