import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import { MeasuredPdfProvider } from "@/components/inspector/measured-pdf-provider";
import { usePdfTabZoom } from "@/components/inspector/use-pdf-tab-zoom";
import { SearchMatchControls } from "@/components/search-match-controls";
import {
  getAdjacentSearchMatchIndex,
  type SearchMatchSummary,
} from "@/lib/search-match-navigation";
import type { NativeSearchDocumentPreviewTarget } from "@/lib/search.logic";
import {
  PeekPdfControls,
  PeekPdfViewer,
} from "@/routes/_protected.workspaces/$workspaceId/-components/peek/peek-pdf-viewer";

type SearchDocumentPreviewProps = {
  fallback: ReactNode;
  searchText: string;
  target: NativeSearchDocumentPreviewTarget;
};

export const SearchDocumentPreview = ({
  fallback,
  searchText,
  target,
}: SearchDocumentPreviewProps) => {
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const [searchMatchSummary, setSearchMatchSummary] =
    useState<SearchMatchSummary>({ count: 0, truncated: false });
  const { handleResetZoom, handleZoom, pdfContentRef, scaleOffsets } =
    usePdfTabZoom({
      activeId: target.fieldId,
      activeTabType: target.filePurpose === "display" ? "pdf" : "docx",
    });
  const scaleOffset = scaleOffsets.get(target.fieldId) ?? 0;
  const handleSearchMatchSummaryChange = useCallback(
    (summary: SearchMatchSummary) => {
      setSearchMatchSummary(summary);
      setActiveSearchMatchIndex((current) =>
        summary.count === 0 ? 0 : Math.min(current, summary.count - 1),
      );
    },
    [],
  );
  const navigateSearchMatches = useCallback(
    (direction: "next" | "previous") => {
      setActiveSearchMatchIndex((current) =>
        getAdjacentSearchMatchIndex({
          activeIndex: current,
          direction,
          matchCount: searchMatchSummary.count,
        }),
      );
    },
    [searchMatchSummary.count],
  );
  const viewer = (
    <PeekPdfViewer
      activeSearchMatchIndex={activeSearchMatchIndex}
      activePropertyId=""
      entityId={target.entityId}
      fieldId={target.fieldId}
      filePurpose={target.filePurpose}
      interactionMode="preview-only"
      mimeType={target.mimeType}
      onSearchMatchSummaryChange={handleSearchMatchSummaryChange}
      scaleOffset={scaleOffset}
      searchText={searchText}
      viewId="all"
      workspaceId={target.workspaceId}
    />
  );

  const content =
    target.filePurpose === "native-display" ? (
      viewer
    ) : (
      <MeasuredPdfProvider
        active
        fallback={{ suspense: fallback }}
        fieldId={target.fieldId}
        initialScaleOffset={scaleOffset}
      >
        {viewer}
      </MeasuredPdfProvider>
    );

  return (
    <div className="relative h-full min-h-0" ref={pdfContentRef}>
      {content}
      <div className="bg-background/80 supports-[backdrop-filter]:bg-background/65 absolute end-2 top-2 z-10 flex items-center gap-1 rounded-md border p-0.5 shadow-sm backdrop-blur">
        {searchMatchSummary.count > 0 && (
          <SearchMatchControls
            activeIndex={activeSearchMatchIndex}
            matchCount={searchMatchSummary.count}
            onNext={() => navigateSearchMatches("next")}
            onPrevious={() => navigateSearchMatches("previous")}
            truncated={searchMatchSummary.truncated}
          />
        )}
        <PeekPdfControls
          canResetZoom={scaleOffset !== 0}
          onResetZoom={() => handleResetZoom(target.fieldId)}
          onZoomIn={() => handleZoom(target.fieldId, "in")}
          onZoomOut={() => handleZoom(target.fieldId, "out")}
          scaleOffset={scaleOffset}
        />
      </div>
    </div>
  );
};
