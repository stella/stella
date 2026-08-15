import { useCallback, useState } from "react";
import type { ReactNode } from "react";

import { MeasuredPdfProvider } from "@/components/inspector/measured-pdf-provider";
import { usePdfTabZoom } from "@/components/inspector/use-pdf-tab-zoom";
import {
  PeekPdfControls,
  PeekPdfViewer,
} from "@/components/pdf/peek/peek-pdf-viewer";
import { SearchMatchControls } from "@/components/search-match-controls";
import {
  getAdjacentSearchMatchIndex,
  type SearchMatchSummary,
} from "@/lib/search-match-navigation";
import type { SearchTextQuery } from "@/lib/search-text";
import type {
  NativeSearchDocumentPreviewTarget,
  NativeSearchStatus,
} from "@/lib/search.logic";
import { shouldShowNativeSearchFallback } from "@/lib/search.logic";

type SearchDocumentPreviewProps = {
  fallback: ReactNode;
  noMatchFallback: ReactNode;
  searchText: SearchTextQuery;
  target: NativeSearchDocumentPreviewTarget;
};

export const SearchDocumentPreview = ({
  fallback,
  noMatchFallback,
  searchText,
  target,
}: SearchDocumentPreviewProps) => {
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const [searchMatchSummary, setSearchMatchSummary] =
    useState<SearchMatchSummary>({ count: 0, truncated: false });
  const [nativeSearchStatus, setNativeSearchStatus] =
    useState<NativeSearchStatus>("pending");
  const { handleResetZoom, handleWheelZoom, handleZoom, scaleOffsets } =
    usePdfTabZoom();
  const scaleOffset = scaleOffsets.get(target.fieldId) ?? 0;
  const handleSearchMatchSummaryChange = useCallback(
    (summary: SearchMatchSummary) => {
      setSearchMatchSummary(summary);
      setNativeSearchStatus(summary.count > 0 ? "matched" : "unmatched");
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
  const handlePreviewError = useCallback(() => {
    setActiveSearchMatchIndex(0);
    setSearchMatchSummary({ count: 0, truncated: false });
    setNativeSearchStatus("unmatched");
  }, []);
  const viewer = (
    <PeekPdfViewer
      activeSearchMatchIndex={activeSearchMatchIndex}
      activePropertyId=""
      entityId={target.entityId}
      fieldId={target.fieldId}
      filePurpose={target.filePurpose}
      interactionMode="preview-only"
      mimeType={target.mimeType}
      onError={handlePreviewError}
      onSearchMatchSummaryChange={handleSearchMatchSummaryChange}
      onWheelZoom={(deltaY) => handleWheelZoom(target.fieldId, deltaY)}
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
  const showNoMatchFallback = shouldShowNativeSearchFallback({
    searchText,
    status: nativeSearchStatus,
  });

  return (
    <div className="relative h-full min-h-0">
      {content}
      {showNoMatchFallback && (
        <div className="bg-background absolute inset-0 z-10 flex min-h-0 flex-col">
          {noMatchFallback}
        </div>
      )}
      {!showNoMatchFallback && (
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
            tooltipLayer="search-child"
          />
        </div>
      )}
    </div>
  );
};
