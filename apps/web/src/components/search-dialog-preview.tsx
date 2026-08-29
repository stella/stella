import { lazy, Suspense, useId, useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";
import { contentDir } from "@stll/ui/use-content-dir";

import { SearchHitIcon } from "@/components/search-dialog-results";
import {
  getEntityLocationRoute,
  getRecentFilePreviewDateVisibility,
  getRecentFilePreviewHit,
} from "@/components/search-dialog.logic";
import {
  KIND_TRANSLATION_KEYS,
  EMPTY_SEARCH_PREVIEW_LOCATOR_CANDIDATES,
  SEARCH_PREVIEW_COLUMN_CLASS_NAME,
  SEARCH_PREVIEW_CONTENT_CLASS_NAME,
} from "@/components/search-dialog.shared";
import { useFormatter } from "@/i18n/formatting-context";
import type { GlobalSearchHit } from "@/lib/api-contract";
import { DOCX_MIME, PDF_MIME } from "@/lib/consts";
import { detached } from "@/lib/detached";
import {
  recentFilePreviewFieldOptions,
  searchPreviewOptions,
} from "@/lib/search";
import type { RecentFile } from "@/lib/search-recents";
import { searchTextQueryKey } from "@/lib/search-text";
import {
  getEmailSearchPreviewTarget,
  getNativeSearchDocumentPreviewTarget,
  getSearchHighlightText,
  getSearchPreviewDate,
  getSearchPreviewRenderContent,
  getSearchPreviewTarget,
  normalizeSearchQuery,
  selectAuthorizedSearchPreviewData,
} from "@/lib/search.logic";

const NativeDocumentPreview = lazy(async () => {
  const { SearchDocumentPreview } =
    await import("@/components/search-document-preview");
  return { default: SearchDocumentPreview };
});

const ChatPreview = lazy(async () => {
  const { SearchChatPreview } =
    await import("@/components/search-chat-preview");
  return { default: SearchChatPreview };
});

// The same email HTML viewer the inspector renders, so an email previews as
// a message, not as extracted text.
const EmailPreview = lazy(async () => {
  const { EmailHtmlViewer } =
    await import("@/components/inspector/email-html-viewer");
  return { default: EmailHtmlViewer };
});

const ignoreSearchPreviewAttachment = (): undefined => undefined;

type SearchPreviewPanelProps = {
  dateVisibility?: "hide" | "show" | undefined;
  hit: GlobalSearchHit;
  locationModifierHeld?: boolean | undefined;
  organizationId: string;
  previewLocatorCandidates?: readonly string[] | undefined;
  query: string;
  userId: string;
  onOpen: (hit: GlobalSearchHit) => void;
};

type RecentFilePreviewPanelProps = {
  file: RecentFile;
  locationModifierHeld?: boolean | undefined;
  onOpen: () => void;
  organizationId: string;
  userId: string;
};

type RecentFilePreviewUnavailableProps = {
  reason: "missing" | "request-error";
};

const RecentFilePreviewUnavailable = ({
  reason,
}: RecentFilePreviewUnavailableProps) => {
  const t = useTranslations();
  let message: string;
  switch (reason) {
    case "missing":
      message = t("search.previewUnavailable");
      break;
    case "request-error":
      message = t("common.somethingWentWrong");
      break;
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
  return (
    <aside className={SEARCH_PREVIEW_COLUMN_CLASS_NAME}>
      <div className="text-muted-foreground flex flex-1 items-center justify-center px-5 text-center text-sm">
        {message}
      </div>
    </aside>
  );
};

export const RecentFilePreviewPanel = ({
  file,
  locationModifierHeld = false,
  onOpen,
  organizationId,
  userId,
}: RecentFilePreviewPanelProps) => {
  const isNativeDocument =
    file.mimeType === PDF_MIME || file.mimeType === DOCX_MIME;
  const fieldQuery = useQuery({
    ...recentFilePreviewFieldOptions({
      entityId: file.entityId,
      fileFieldId: file.fileFieldId,
      filePropertyId: file.filePropertyId,
      mimeType: file.mimeType ?? null,
      organizationId,
      userId,
      workspaceId: file.workspaceId,
    }),
    enabled: isNativeDocument,
  });
  if (isNativeDocument && fieldQuery.isPending) {
    return (
      <aside className={SEARCH_PREVIEW_COLUMN_CLASS_NAME}>
        <NativeDocumentPreviewSkeleton />
      </aside>
    );
  }
  if (isNativeDocument && fieldQuery.isError) {
    return <RecentFilePreviewUnavailable reason="request-error" />;
  }
  if (isNativeDocument && fieldQuery.data === null) {
    return <RecentFilePreviewUnavailable reason="missing" />;
  }

  const resolvedFieldId = isNativeDocument
    ? (fieldQuery.data ?? null)
    : (file.fileFieldId ?? null);
  const hit = getRecentFilePreviewHit(file, resolvedFieldId);

  return (
    <SearchPreviewPanel
      dateVisibility={getRecentFilePreviewDateVisibility(file)}
      hit={hit}
      locationModifierHeld={locationModifierHeld}
      onOpen={onOpen}
      organizationId={organizationId}
      query=""
      userId={userId}
    />
  );
};

export const SearchPreviewPanel = ({
  dateVisibility = "show",
  hit,
  locationModifierHeld = false,
  organizationId,
  previewLocatorCandidates = EMPTY_SEARCH_PREVIEW_LOCATOR_CANDIDATES,
  query,
  userId,
  onOpen,
}: SearchPreviewPanelProps) => {
  const t = useTranslations();
  const headingId = useId();

  return (
    <aside
      aria-labelledby={headingId}
      className={SEARCH_PREVIEW_COLUMN_CLASS_NAME}
    >
      <h2 className="sr-only" id={headingId}>
        {t("common.preview")}
      </h2>
      <SearchPreviewContent
        dateVisibility={dateVisibility}
        hit={hit}
        key={`${hit.type}:${hit.id}:${hit.updatedAt}:${normalizeSearchQuery(query)}`}
        locationModifierHeld={locationModifierHeld}
        onOpen={onOpen}
        organizationId={organizationId}
        previewLocatorCandidates={previewLocatorCandidates}
        query={query}
        userId={userId}
      />
    </aside>
  );
};

type SearchPreviewContentProps = {
  dateVisibility: "hide" | "show";
  hit: GlobalSearchHit;
  locationModifierHeld: boolean;
  organizationId: string;
  previewLocatorCandidates: readonly string[];
  query: string;
  userId: string;
  onOpen: (hit: GlobalSearchHit) => void;
};

const SearchPreviewContent = ({
  dateVisibility,
  hit,
  locationModifierHeld,
  organizationId,
  previewLocatorCandidates,
  query,
  userId,
  onOpen,
}: SearchPreviewContentProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const location =
    hit.type === "contact" || hit.type === "case-law"
      ? null
      : hit.workspaceName;
  const opensLocation =
    locationModifierHeld &&
    location !== null &&
    getEntityLocationRoute(hit) !== null;
  const previewDate =
    dateVisibility === "show" ? getSearchPreviewDate(hit) : null;
  const formattedPreviewDate = previewDate
    ? format.dateTime(new Date(previewDate.value), {
        month: "short",
        year: "numeric",
        ...(previewDate.type === "calendar-date" ? { timeZone: "UTC" } : {}),
      })
    : null;

  return (
    <>
      <div className="shrink-0 border-b px-4 py-3">
        <div className="flex items-start gap-3">
          <SearchHitIcon hit={hit} />
          <div className="min-w-0 flex-1">
            <BidiText as="p" className="line-clamp-2 text-sm font-medium">
              {hit.title || hit.id}
            </BidiText>
            <p className="text-muted-foreground mt-0.5 truncate text-xs">
              <BidiText>{t(KIND_TRANSLATION_KEYS[hit.type])}</BidiText>
              {location && (
                <>
                  <span aria-hidden="true">{" · "}</span>
                  <BidiText>{location}</BidiText>
                </>
              )}
              {formattedPreviewDate && (
                <>
                  <span aria-hidden="true">{" · "}</span>
                  <BidiText>{formattedPreviewDate}</BidiText>
                </>
              )}
            </p>
          </div>
          <Button
            className="min-w-0 shrink-0"
            onClick={() => {
              onOpen(hit);
            }}
            size="sm"
            variant="outline"
          >
            {opensLocation ? (
              <span className="max-w-48 truncate">
                {t.rich("search.openMatter", {
                  bdi: (chunks) => <BidiText>{chunks}</BidiText>,
                  name: location,
                })}
              </span>
            ) : (
              t("common.open")
            )}
          </Button>
        </div>
      </div>
      <SearchPreviewBody
        hit={hit}
        organizationId={organizationId}
        previewLocatorCandidates={previewLocatorCandidates}
        query={query}
        userId={userId}
      />
    </>
  );
};

type SearchPreviewBodyProps = Pick<
  SearchPreviewContentProps,
  "hit" | "organizationId" | "previewLocatorCandidates" | "query" | "userId"
>;

const SearchPreviewBody = (props: SearchPreviewBodyProps) => {
  const { hit } = props;
  const searchText = useMemo(
    () =>
      getSearchHighlightText({
        headline: hit.headline,
        previewLocatorCandidates: props.previewLocatorCandidates,
        query: props.query,
      }),
    [hit.headline, props.previewLocatorCandidates, props.query],
  );
  const emailPreviewTarget = getEmailSearchPreviewTarget(hit);
  if (emailPreviewTarget) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Suspense fallback={<SearchTextPreviewSkeleton />}>
          <EmailPreview
            entityId={emailPreviewTarget.entityId}
            fieldId={emailPreviewTarget.fieldId}
            key={emailPreviewTarget.fieldId}
            onOpenAttachment={ignoreSearchPreviewAttachment}
            workspaceId={emailPreviewTarget.workspaceId}
          />
        </Suspense>
      </div>
    );
  }
  const nativePreviewTarget = getNativeSearchDocumentPreviewTarget(hit);
  if (nativePreviewTarget) {
    return (
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={<NativeDocumentPreviewSkeleton />}>
          <NativeDocumentPreview
            fallback={<NativeDocumentPreviewSkeleton />}
            key={`${hit.id}:${searchTextQueryKey(searchText)}`}
            noMatchFallback={<SearchTextPreview {...props} />}
            searchText={searchText}
            target={nativePreviewTarget}
          />
        </Suspense>
      </div>
    );
  }
  return <SearchTextPreview {...props} />;
};

const NativeDocumentPreviewSkeleton = () => (
  <div className="bg-muted/40 flex h-full justify-center overflow-hidden p-3">
    <Skeleton className="h-[calc(100%+8rem)] w-full max-w-sm rounded-sm" />
  </div>
);

const SearchTextPreview = ({
  hit,
  organizationId,
  previewLocatorCandidates,
  query,
  userId,
}: SearchPreviewBodyProps) => {
  const t = useTranslations();
  const searchText = useMemo(
    () =>
      getSearchHighlightText({
        headline: hit.headline,
        previewLocatorCandidates,
        query,
      }),
    [hit.headline, previewLocatorCandidates, query],
  );
  const target = getSearchPreviewTarget(hit);
  const { data, isError, isFetching, refetch } = useQuery(
    searchPreviewOptions({
      organizationId,
      query,
      resultId: target.resultId,
      type: target.type,
      updatedAt: hit.updatedAt,
      userId,
    }),
  );
  const authorizedData = selectAuthorizedSearchPreviewData({ data, isError });
  const renderContent = authorizedData
    ? getSearchPreviewRenderContent(authorizedData)
    : null;

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5"
      data-slot="search-preview-scroll-area"
    >
      {!isError && authorizedData === undefined && (
        <div className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="mt-6 h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      )}
      {isError && (
        <div className="flex min-h-48 flex-col items-center justify-center gap-3">
          <p className="text-muted-foreground text-sm">
            {t("common.somethingWentWrong")}
          </p>
          <Button
            disabled={isFetching}
            onClick={() => {
              detached(refetch(), "search-dialog.refetch");
            }}
            size="sm"
            variant="outline"
          >
            {t("common.retry")}
          </Button>
        </div>
      )}
      {renderContent?.type === "plain-text" && (
        <div
          className={SEARCH_PREVIEW_CONTENT_CLASS_NAME}
          dir={contentDir(renderContent.directionText)}
        >
          {renderContent.text}
        </div>
      )}
      {renderContent?.type === "chat-messages" && (
        <Suspense fallback={<SearchTextPreviewSkeleton />}>
          <ChatPreview
            messages={renderContent.messages}
            searchText={searchText}
          />
        </Suspense>
      )}
      {renderContent?.type === "highlighted-html" && (
        <div
          className={SEARCH_PREVIEW_CONTENT_CLASS_NAME}
          dir={contentDir(renderContent.directionText)}
          dangerouslySetInnerHTML={{
            // safe-html: preview content is server-escaped before the trusted <mark> tags are inserted
            __html: renderContent.html,
          }}
        />
      )}
    </div>
  );
};

const SearchTextPreviewSkeleton = () => (
  <div className="space-y-3">
    <Skeleton className="h-12 w-4/5" />
    <Skeleton className="ms-auto h-16 w-3/4" />
    <Skeleton className="h-20 w-11/12" />
  </div>
);
