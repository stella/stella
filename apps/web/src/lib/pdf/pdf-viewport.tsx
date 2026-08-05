import { startTransition, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useFormStatus } from "react-dom";

import { useQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/react/shallow";

import { Button } from "@stll/ui/components/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/components/field";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { composeRefs } from "@stll/ui/lib/utils";

import { SecretInput } from "@/components/secret-input";
import { useTheme } from "@/components/theme-provider";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePageVisibility } from "@/lib/pdf/hooks/use-page-visibility";
import { usePDFControlledScaleOffset } from "@/lib/pdf/hooks/use-pdf-controlled-scale-offset";
import { usePDFDocument } from "@/lib/pdf/hooks/use-pdf-document";
import { usePDFExternalPageSync } from "@/lib/pdf/hooks/use-pdf-external-page-sync";
import { usePDFFitToWidth } from "@/lib/pdf/hooks/use-pdf-fit-to-width";
import { useTextSelection } from "@/lib/pdf/hooks/use-text-selection";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import type { PDFDocument } from "@/lib/pdf/pdf-loader";
import type { PDFPageProps } from "@/lib/pdf/pdf-page";
import { approximateFraction } from "@/lib/pdf/pdfjs-utils";
import { getDevicePixelRatio } from "@/lib/pdf/utils";
import {
  getSettledSearchMatchSummary,
  type SearchMatchSummary,
} from "@/lib/search-match-navigation";
import { getSearchTextCandidates } from "@/lib/search-text";
import type { SearchTextQuery } from "@/lib/search-text";

export { usePDFStore } from "@/lib/pdf/pdf-context";

const [, roundY] = approximateFraction(getDevicePixelRatio());

type PDFViewportProps = {
  fileId: string;
  buffer: ArrayBuffer;
  page?: number | undefined;
  onPageChanged?: ((page: number) => void) | undefined;
  password?: string | undefined;
  scaleOffset?: number | undefined;
  invertColors?: boolean | undefined;
  className?: string | undefined;
  contentClassName?: string | undefined;
  searchText?: SearchTextQuery | undefined;
  activeSearchMatchIndex?: number | undefined;
  onSearchMatchSummaryChange?:
    | ((summary: SearchMatchSummary) => void)
    | undefined;
  renderPage: (props: PDFPageProps) => ReactNode;
};

type PDFViewerContentProps = Omit<
  PDFViewportProps,
  "fileId" | "password" | "buffer"
> & {
  buffer: ArrayBuffer;
  document: PDFDocument;
  password?: string | undefined;
};

type PDFViewportStyle = CSSProperties & {
  "--pdf-page-filter": string;
  "--scale-factor": number;
  "--scale-round-x": string;
  "--scale-round-y": string;
};

export const PDFViewport = ({
  fileId,
  buffer,
  password: initialPassword,
  ...contentProps
}: PDFViewportProps) => {
  const [password, setPassword] = useState(initialPassword);

  // Re-sync local password to the initialPassword prop using React's
  // adjust-state-during-render pattern instead of a reset effect. setPassword is
  // also driven by the password prompt below, so this is not pure derived state;
  // tracking the previous prop value resets only when the prop actually changes.
  const [prevInitialPassword, setPrevInitialPassword] =
    useState(initialPassword);
  if (initialPassword !== prevInitialPassword) {
    setPrevInitialPassword(initialPassword);
    setPassword(initialPassword);
  }

  const { data: result, refetch } = usePDFDocument({
    key: { fileId },
    context: { buffer, password },
  });

  if (Result.isOk(result)) {
    return (
      <PDFViewerContent
        {...contentProps}
        buffer={buffer}
        document={result.value}
        password={password}
      />
    );
  }

  if (
    result.error.code === "PASSWORD_REQUIRED" ||
    result.error.code === "INCORRECT_PASSWORD"
  ) {
    return (
      <PDFPasswordPrompt
        onSubmit={(value) => {
          setPassword(value);
          refetch();
        }}
        incorrectPassword={result.error.code === "INCORRECT_PASSWORD"}
      />
    );
  }

  throw result.error;
};

const PDFViewerContent = ({
  buffer,
  document,
  password,
  page,
  onPageChanged,
  scaleOffset = 0,
  invertColors,
  className,
  contentClassName,
  searchText = "",
  activeSearchMatchIndex = 0,
  onSearchMatchSummaryChange,
  renderPage,
}: PDFViewerContentProps) => {
  const { resolvedTheme } = useTheme();
  const shouldInvert = invertColors ?? resolvedTheme === "dark";
  const [attachmentLabels, scale, pages, setDocument, setScrollTo] =
    usePDFStore(
      useShallow((s) => [
        s.attachmentLabels,
        s.scale,
        s.pages,
        s.setDocument,
        s.setScrollTo,
      ]),
    );
  const hasSearchText = getSearchTextCandidates(searchText).length > 0;
  const searchPageQuery = useQuery({
    enabled: hasSearchText,
    queryFn: async ({ signal }) => {
      const { findPDFSearchResultsInWorker } =
        await import("@/lib/pdf/pdf-search-worker-client");
      signal.throwIfAborted();
      return await findPDFSearchResultsInWorker({
        bytes: buffer.slice(0),
        password,
        searchText,
        signal,
      });
    },
    queryKey: [
      "pdf-search-page",
      document.document.fingerprints,
      searchText,
      password === undefined ? "unprotected" : "password-protected",
    ],
    staleTime: Number.POSITIVE_INFINITY,
  });

  const effectiveScale = scale + scaleOffset;
  const pageIds = useMemo(() => pages.keys().toArray(), [pages]);
  const activeSearchMatch = searchPageQuery.data?.matches.at(
    activeSearchMatchIndex,
  );
  const searchPageId = activeSearchMatch
    ? pageIds.at(activeSearchMatch.pageIndex)
    : undefined;
  const settledSearchMatchSummary = getSettledSearchMatchSummary({
    isSettled: searchPageQuery.isSuccess,
    result: searchPageQuery.data,
  });
  const settledSearchMatchCount = settledSearchMatchSummary?.count;
  const settledSearchMatchTruncated = settledSearchMatchSummary?.truncated;
  const viewportStyle: PDFViewportStyle = {
    "--pdf-page-filter": shouldInvert ? "invert(1) hue-rotate(180deg)" : "none",
    "--scale-factor": effectiveScale,
    "--scale-round-x": `${roundY}px`,
    "--scale-round-y": `${roundY}px`,
  };

  const containerRef = useRef<HTMLDivElement>(null);

  useExternalSyncEffect(() => {
    startTransition(() => {
      setDocument(document);
    });
  }, [document, setDocument]);

  useExternalSyncEffect(() => {
    if (searchPageId) {
      setScrollTo({
        pageId: searchPageId,
        target: { kind: "searchMatch", matchIndex: activeSearchMatchIndex },
      });
    }
  }, [activeSearchMatchIndex, searchPageId, setScrollTo]);

  useExternalSyncEffect(() => {
    if (
      settledSearchMatchCount === undefined ||
      settledSearchMatchTruncated === undefined
    ) {
      return;
    }

    onSearchMatchSummaryChange?.({
      count: settledSearchMatchCount,
      truncated: settledSearchMatchTruncated,
    });
  }, [
    onSearchMatchSummaryChange,
    settledSearchMatchCount,
    settledSearchMatchTruncated,
  ]);

  useTextSelection(containerRef);
  const fitToWidthRef = usePDFFitToWidth({
    containerRef,
  });
  usePDFControlledScaleOffset({
    containerRef,
    controlledScaleOffset: scaleOffset,
  });
  const { containerRef: pageVisibilityRef, lastReportedPageRef } =
    usePageVisibility({
      pageIds,
      onPageChanged,
    });
  usePDFExternalPageSync({
    page,
    pageIds,
    lastReportedPageRef,
  });

  const pdfContentRef = useMemo(
    () => composeRefs(containerRef, fitToWidthRef, pageVisibilityRef),
    [fitToWidthRef, pageVisibilityRef],
  );

  if (searchPageQuery.error && !searchPageQuery.isFetching) {
    throw searchPageQuery.error;
  }

  return (
    // The surround background lives on the (non-scrolling) ScrollArea
    // root, not on an inner `h-full` wrapper. A wrapper sized to the
    // viewport only paints the first viewport-rect of the scroll
    // content, so any taller/wider page (or zoom/scroll offset) let the
    // parent's lighter background bleed through past it — a two-tone
    // surround. Painting on the root fills the whole visible area
    // uniformly at every scroll position and page size.
    //
    // `scrollbarClassName` elevates the scrollbar above the docked AI
    // chat composer: every mount of this viewport is wrapped in
    // `FileViewerWithAI` (peek and full view alike), whose composer
    // stack floats at z-50 over the bottom of the viewer. Without this
    // the scrollbar's bottom section painted underneath that glass veil
    // instead of on top of it.
    <ScrollArea className={className} scrollbarClassName="z-[60]">
      <div
        ref={pdfContentRef}
        className={contentClassName}
        style={viewportStyle}
      >
        {pageIds.map((pageId, pageIndex) => {
          const label = attachmentLabels.get(pageId);
          const searchMatches = searchPageQuery.data?.matches.flatMap(
            (match, matchIndex) =>
              match.pageIndex === pageIndex
                ? [{ boxes: match.boxes, matchIndex }]
                : [],
          );

          return (
            <div key={pageId}>
              {label && <PDFBanner label={label} />}
              {renderPage({
                activeSearchMatchIndex,
                pageId,
                searchMatches,
              })}
            </div>
          );
        })}
        <div className="h-px" />
      </div>
    </ScrollArea>
  );
};

const PDFBanner = ({ label }: { label: string }) => (
  <div className="bg-muted text-muted-foreground mx-auto flex items-center justify-center rounded-md px-4 py-2 text-center text-sm">
    {label}
  </div>
);

type PDFPasswordPromptProps = {
  onSubmit: (password: string) => void;
  incorrectPassword: boolean;
};

const PDFPasswordPrompt = ({
  onSubmit,
  incorrectPassword,
}: PDFPasswordPromptProps) => {
  const id = useId();
  const t = useTranslations();
  const [value, setValue] = useState("");

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-4 py-6">
      <form
        action={() => {
          onSubmit(value);
        }}
        className="w-full max-w-sm space-y-3"
      >
        <Field invalid={incorrectPassword}>
          <FieldLabel htmlFor={id}>
            {t("workspaces.pdf.passwordLabel")}
          </FieldLabel>
          <SecretInput
            aria-invalid={incorrectPassword}
            autoComplete="off"
            id={id}
            onChange={(e) => {
              setValue(e.target.value);
            }}
            value={value}
          />
          {incorrectPassword && (
            <FieldError match>
              {t("workspaces.pdf.incorrectPassword")}
            </FieldError>
          )}
        </Field>
        <PDFPasswordSubmitButton label={t("workspaces.pdf.unlock")} />
      </form>
    </div>
  );
};

const PDFPasswordSubmitButton = ({ label }: { label: string }) => {
  const { pending } = useFormStatus();
  return (
    <Button className="w-full" disabled={pending} type="submit">
      {label}
    </Button>
  );
};
