import { useCallback, useMemo, useRef, useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import { CopyIcon, ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { FetchBoundaryError } from "@stll/errors";
import { fetchWithTimeout } from "@stll/fetch";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { MessageResponse } from "@/components/ai-elements/message";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import { CompanyRegistryPreview } from "@/components/company-registry-preview";
import { findMcpConnectorIconHref } from "@/components/inspector/external-source-icon";
import {
  InspectorFindBar,
  useInspectorFind,
} from "@/components/inspector/inspector-find";
import { InspectorTabHeader } from "@/components/inspector/inspector-tab-header";
import type { InspectorTab } from "@/components/inspector/inspector-tabs-store";
import { MeasuredPdfProvider } from "@/components/inspector/measured-pdf-provider";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { BoundedSet } from "@/lib/bounded-set";
import { createChatThreadId, toChatThreadId } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { APIError, toAPIError } from "@/lib/errors/api";
import { mcpConnectorsOptions } from "@/lib/knowledge/queries";
import { openIsolatedWindow } from "@/lib/open-isolated-window";
import { PDFPage } from "@/lib/pdf/pdf-page";
import type { PDFPageFallback } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import { sanitizeHref } from "@/lib/sanitize-href";

const SERVER_PREVIEW_ERROR_THRESHOLD = 500;

const toastedPreviewFailures = new BoundedSet<string>(100);

export type ExternalReferencePanelProps = {
  onClose: () => void;
  tab: Extract<InspectorTab, { type: "external" }>;
  workspaceId?: string | undefined;
};

export const ExternalSourceLogo = ({
  className,
  iconHref,
}: {
  className?: string | undefined;
  iconHref?: string | undefined;
}) => {
  if (iconHref) {
    return (
      <span
        className={cn(
          "bg-background flex size-4 shrink-0 items-center justify-center rounded-sm border",
          className,
        )}
      >
        <img
          alt=""
          className="size-3 rounded-xs object-contain"
          height={12}
          src={iconHref}
          width={12}
        />
      </span>
    );
  }

  return (
    <ExternalLinkIcon
      className={cn("text-muted-foreground size-3.5 shrink-0", className)}
    />
  );
};

type ExternalPdfState =
  | {
      status: "idle" | "loading" | "error";
      buffer?: undefined;
      token?: undefined;
    }
  | { status: "ready"; buffer: ArrayBuffer; token: string };

type ExternalPdfPayload = { buffer: ArrayBuffer; token: string };

const useExternalPdfBuffer = ({
  enabled,
  url,
}: {
  enabled: boolean;
  url?: string | undefined;
}): ExternalPdfState => {
  const query = useQuery({
    queryKey: ["external-pdf", url],
    queryFn: async ({ signal }): Promise<ExternalPdfPayload> => {
      if (url === undefined) {
        throw new FetchBoundaryError({
          url: "",
          status: 0,
          statusText: "Missing URL",
          message: "External PDF URL missing",
        });
      }

      const response = await fetchWithTimeout(url, {
        credentials: "include",
        signal,
        timeoutMs: 60_000,
      });

      if (!response.ok) {
        throw new FetchBoundaryError({
          url,
          status: response.status,
          statusText: response.statusText,
          message: `External PDF fetch failed: ${String(response.status)}`,
        });
      }

      const buffer = await response.arrayBuffer();
      // The PDF document cache (`usePDFDocument`) keys only by
      // `fileId` and ignores the buffer, so a same-URL refetch with
      // new bytes would otherwise return the stale parsed document.
      // The token rotates per fresh fetch and is folded into the
      // `fileId` so each new buffer parses from scratch.
      return { buffer, token: crypto.randomUUID() };
    },
    enabled: enabled && url !== undefined,
    // Large binaries — keep them cached for the session so toggling
    // tabs doesn't trigger a re-download.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  if (!enabled || url === undefined) {
    return { status: "idle" };
  }
  if (query.isError) {
    return { status: "error" };
  }
  if (query.data === undefined) {
    return { status: "loading" };
  }
  return {
    status: "ready",
    buffer: query.data.buffer,
    token: query.data.token,
  };
};

const externalPdfSuspenseFallback = (
  <div className="space-y-3 p-4">
    <Skeleton className="h-4 w-2/3" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
    <Skeleton className="h-4 w-4/5" />
  </div>
);

const ExternalPdfPreview = ({
  buffer,
  onOpenOriginal,
  status,
  url,
  token,
}: {
  buffer: ArrayBuffer | undefined;
  onOpenOriginal: () => void;
  status: "error" | "idle" | "loading" | "ready";
  url: string;
  token: string | undefined;
}) => {
  if (status === "error") {
    return (
      <ExternalPreviewUnavailable
        canOpenOriginal
        onOpenOriginal={onOpenOriginal}
      />
    );
  }

  if (buffer === undefined || token === undefined || status !== "ready") {
    return externalPdfSuspenseFallback;
  }

  // Token rotates per buffer fetch so the PDF document cache (which
  // keys by fileId only) parses fresh bytes instead of returning the
  // stale parsed document. The `key` on MeasuredPdfProvider forces
  // the underlying store to remount whenever a new buffer arrives.
  const fileId = `external:${url}:${token}`;
  const fallback: PDFPageFallback = {
    suspense: externalPdfSuspenseFallback,
    error: (
      <ExternalPreviewUnavailable
        canOpenOriginal
        onOpenOriginal={onOpenOriginal}
      />
    ),
  };

  return (
    <MeasuredPdfProvider
      active
      fallback={fallback}
      fieldId={fileId}
      initialScaleOffset={0}
      key={fileId}
    >
      <PDFViewport
        buffer={buffer}
        className="document-preview-surface h-full"
        contentClassName="relative space-y-2 px-2 pt-2"
        fileId={fileId}
        renderPage={(props) => <PDFPage {...props} />}
      />
    </MeasuredPdfProvider>
  );
};

const ExternalPreviewUnavailable = ({
  canOpenOriginal,
  onOpenOriginal,
}: {
  canOpenOriginal: boolean;
  onOpenOriginal: () => void;
}) => {
  const t = useTranslations();

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <ExternalLinkIcon className="text-muted-foreground mx-auto size-6" />
        <p className="text-muted-foreground mt-3 text-sm">
          {t("inspector.external.unavailable")}
        </p>
        {canOpenOriginal && (
          <Button
            className="mt-4"
            aria-label={t("inspector.external.openOriginal")}
            onClick={onOpenOriginal}
            size="sm"
            variant="outline"
          >
            <ExternalLinkIcon className="size-3.5" />
            {t("inspector.external.openOriginal")}
          </Button>
        )}
      </div>
    </div>
  );
};

const GenericExternalReferencePanel = ({
  onClose,
  tab,
  workspaceId,
}: ExternalReferencePanelProps) => {
  const t = useTranslations();
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  // Stable fallback chat-thread id, generated once per mount. useState (not a
  // ref) so it can be read during render without a ref-access warning.
  const [fallbackChatThreadId] = useState(() => createChatThreadId());
  const safeHref = sanitizeHref(tab.url);
  const [confirmHref, setConfirmHref] = useState<string | undefined>();
  const canPreview =
    safeHref !== undefined &&
    (safeHref.startsWith("https://") || safeHref.startsWith("http://"));
  const storedSource = useExternalSourceStore((state) =>
    safeHref === undefined ? undefined : state.sourcesByUrl[safeHref],
  );
  const shouldFetchPreview =
    canPreview &&
    tab.text === undefined &&
    storedSource?.text === undefined &&
    (tab.connectorSlug !== undefined ||
      tab.sourceToolName !== undefined ||
      storedSource?.connectorSlug !== undefined ||
      storedSource?.sourceToolName !== undefined);
  const previewErrorTitle = t("common.somethingWentWrong");
  const { data: fetchedPreview, isLoading: previewLoading } = useQuery({
    queryKey: ["external-preview", tab.url, previewErrorTitle],
    queryFn: async ({ signal }) => {
      const response = await api["external-preview"].get({
        query: { url: tab.url },
        fetch: { signal },
      });

      if (response.error) {
        const error = toAPIError(response.error);
        if (
          APIError.is(error) &&
          error.status >= SERVER_PREVIEW_ERROR_THRESHOLD
        ) {
          const toastKey = `${tab.url}|${error.status}`;
          if (!toastedPreviewFailures.has(toastKey)) {
            toastedPreviewFailures.add(toastKey);
            stellaToast.add({
              title: previewErrorTitle,
              description: error.message,
              type: "error",
            });
          }
        }
        throw error;
      }

      return response.data;
    },
    enabled: shouldFetchPreview,
    retry: false,
    staleTime: 1000 * 60 * 10,
  });

  const previewTitle = fetchedPreview?.title ?? storedSource?.title;
  const previewText = tab.text ?? storedSource?.text ?? fetchedPreview?.text;
  const previewSnippet = tab.snippet ?? storedSource?.snippet;
  const provider = tab.provider ?? storedSource?.provider;
  const connectorSlug = tab.connectorSlug ?? storedSource?.connectorSlug;
  const storedIconHref = tab.iconHref ?? storedSource?.iconHref;
  const sourceToolName = tab.sourceToolName ?? storedSource?.sourceToolName;
  const externalFilePreviewUrl =
    safeHref === undefined
      ? undefined
      : apiUrl(`/external-preview/file?url=${encodeURIComponent(safeHref)}`);
  const shouldLoadExternalPdf =
    fetchedPreview?.format === "pdf" && externalFilePreviewUrl !== undefined;
  const externalPdfPreview = useExternalPdfBuffer({
    enabled: shouldLoadExternalPdf,
    url: externalFilePreviewUrl,
  });
  const persistedExternalTab: { chatThreadId?: string | undefined } = tab;
  const externalChatThreadId =
    persistedExternalTab.chatThreadId === undefined
      ? fallbackChatThreadId
      : toChatThreadId(persistedExternalTab.chatThreadId);
  const hasMetadata =
    provider !== undefined ||
    connectorSlug !== undefined ||
    sourceToolName !== undefined;
  const activeExternal = useMemo(
    () =>
      canPreview
        ? {
            connectorSlug,
            provider,
            snippet: previewSnippet,
            sourceToolName,
            text: previewText,
            title: previewTitle ?? tab.label,
            url: safeHref,
          }
        : undefined,
    [
      canPreview,
      connectorSlug,
      provider,
      previewText,
      previewTitle,
      previewSnippet,
      safeHref,
      tab.label,
      sourceToolName,
    ],
  );
  const contentRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const find = useInspectorFind({
    contentRef,
    enabled: previewText !== undefined,
    highlightKey: tab.id,
    panelRef,
  });
  const { data: mcpConnectorsData } = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled: connectorSlug !== undefined,
  });
  const availableConnectors = mcpConnectorsData
    ? mcpConnectorsData.connectors
    : [];
  const iconHref =
    storedIconHref ??
    (connectorSlug === undefined
      ? undefined
      : findMcpConnectorIconHref({
          connectorSlug,
          connectors: availableConnectors,
        }));
  const requestOpenExternal = useCallback(
    (href: string) => {
      setConfirmHref(href);
    },
    [setConfirmHref],
  );
  const requestSafeExternalOpen = useCallback(() => {
    if (safeHref === undefined) {
      return;
    }

    requestOpenExternal(safeHref);
  }, [requestOpenExternal, safeHref]);
  const openConfirmedExternal = useCallback(() => {
    if (confirmHref === undefined) {
      return;
    }

    openIsolatedWindow(confirmHref);
    setConfirmHref(undefined);
  }, [confirmHref, setConfirmHref]);
  const copyConfirmHref = useCallback(async () => {
    if (confirmHref === undefined) {
      return;
    }

    const copied = await copyToClipboard(confirmHref);
    if (Result.isError(copied)) {
      getAnalytics().captureError(copied.error);
      stellaToast.error(t("common.error"));
      return;
    }
    stellaToast.success(t("common.copied"));
  }, [confirmHref, t]);

  return (
    <div
      className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden"
      ref={panelRef}
    >
      <InspectorTabHeader
        actions={
          <div className="flex items-center gap-1">
            {previewText && (
              <Button
                aria-label={t("common.find")}
                onClick={find.openFind}
                size="xs"
                title="Cmd+F"
                variant="ghost"
              >
                <SearchIcon className="size-3.5" />
                {t("common.find")}
              </Button>
            )}
            {canPreview && (
              <Button
                aria-label={t("inspector.external.openOriginal")}
                onClick={() => {
                  requestOpenExternal(safeHref);
                }}
                size="xs"
                variant="ghost"
              >
                <ExternalLinkIcon className="size-3.5" />
                {t("inspector.external.openOriginal")}
              </Button>
            )}
          </div>
        }
        label={tab.label}
        onClose={onClose}
      />
      <FileViewerWithAI
        activeExternal={activeExternal}
        chatThreadId={externalChatThreadId}
        className="min-h-0 flex-1"
        workspaceId={workspaceId}
      >
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <div className="flex h-12 flex-col justify-center overflow-hidden border-b px-3">
            {hasMetadata && (
              <div className="flex min-w-0 items-center gap-1.5">
                <ExternalSourceLogo iconHref={iconHref} />
                {provider && (
                  <p className="text-muted-foreground truncate text-xs">
                    {provider}
                  </p>
                )}
                {connectorSlug && (
                  <span className="bg-muted text-muted-foreground text-3xs max-w-24 truncate rounded px-1.5 py-0.5 font-mono">
                    {connectorSlug}
                  </span>
                )}
                {sourceToolName && (
                  <span className="bg-muted text-muted-foreground text-3xs min-w-0 truncate rounded px-1.5 py-0.5 font-mono">
                    {sourceToolName}
                  </span>
                )}
              </div>
            )}
            {canPreview && (
              <button
                className={cn(
                  "text-muted-foreground hover:text-foreground truncate text-start text-xs underline-offset-2 hover:underline",
                  hasMetadata && "mt-1",
                )}
                onClick={() => {
                  requestOpenExternal(safeHref);
                }}
                type="button"
              >
                {safeHref}
              </button>
            )}
          </div>
          <InspectorFindBar find={find} />
          {(() => {
            if (previewLoading) {
              return (
                <div className="space-y-3 p-4">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-4 w-4/5" />
                </div>
              );
            }
            if (shouldLoadExternalPdf) {
              return (
                <ExternalPdfPreview
                  buffer={externalPdfPreview.buffer}
                  onOpenOriginal={requestSafeExternalOpen}
                  status={externalPdfPreview.status}
                  token={externalPdfPreview.token}
                  url={externalFilePreviewUrl}
                />
              );
            }
            if (previewText || tab.snippet) {
              return (
                <ScrollArea className="min-h-0 flex-1">
                  <article className="max-w-none px-4 py-3" ref={contentRef}>
                    {previewSnippet && (
                      <p className="text-muted-foreground border-b pb-3 text-sm">
                        {previewSnippet}
                      </p>
                    )}
                    {previewText && (
                      <div className="text-foreground text-sm leading-6">
                        {previewTitle && previewTitle !== tab.label ? (
                          <h2 className="mb-3 font-medium">{previewTitle}</h2>
                        ) : null}
                        {fetchedPreview?.format === "markdown" ? (
                          <MessageResponse className="text-sm">
                            {previewText}
                          </MessageResponse>
                        ) : (
                          <div className="whitespace-pre-wrap">
                            {previewText}
                          </div>
                        )}
                      </div>
                    )}
                  </article>
                </ScrollArea>
              );
            }
            return (
              <ExternalPreviewUnavailable
                canOpenOriginal={canPreview}
                onOpenOriginal={requestSafeExternalOpen}
              />
            );
          })()}
        </div>
      </FileViewerWithAI>
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setConfirmHref(undefined);
          }
        }}
        open={confirmHref !== undefined}
      >
        <DialogPopup className="sm:max-w-md">
          <DialogHeader className="pe-12">
            <DialogTitle className="flex items-center gap-2">
              <ExternalLinkIcon className="size-5" />
              {t("inspector.external.confirmTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("inspector.external.confirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="bg-muted rounded-md px-3 py-3 font-mono text-sm break-all">
              {confirmHref}
            </div>
          </DialogPanel>
          <DialogFooter
            className="grid grid-cols-2 gap-2 sm:grid-cols-2"
            variant="bare"
          >
            <Button
              onClick={() => {
                detached(
                  copyConfirmHref(),
                  "external-reference-panel.copy-confirm-href",
                );
              }}
              variant="outline"
            >
              <CopyIcon className="size-4" />
              {t("common.copyLink")}
            </Button>
            <Button onClick={openConfirmedExternal}>
              <ExternalLinkIcon className="size-4" />
              {t("inspector.external.openLink")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
};

export const ExternalReferencePanel = ({
  onClose,
  tab,
  workspaceId,
}: ExternalReferencePanelProps) => {
  const safeHref = sanitizeHref(tab.url);
  const businessRegistry = useExternalSourceStore((state) =>
    safeHref === undefined
      ? undefined
      : state.sourcesByUrl[safeHref]?.businessRegistry,
  );

  if (businessRegistry === undefined) {
    return (
      <GenericExternalReferencePanel
        onClose={onClose}
        tab={tab}
        workspaceId={workspaceId}
      />
    );
  }

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <InspectorTabHeader label={tab.label} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CompanyRegistryPreview
          companyId={businessRegistry.companyId}
          registry={businessRegistry.registry}
        />
      </div>
    </div>
  );
};
