import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";

import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  ExternalLinkIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/components/dialog";
import { Input } from "@stll/ui/components/input";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { MessageResponse } from "@/components/ai-elements/message";
import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { useExternalSourceStore } from "@/components/chat/external-source-store";
import { api } from "@/lib/api";
import { apiUrl } from "@/lib/api-url";
import { createChatThreadId, toChatThreadId } from "@/lib/chat-thread-ref";
import { APIError, FetchBoundaryError, toAPIError } from "@/lib/errors";
import { PDFPage } from "@/lib/pdf/pdf-page";
import type { PDFPageFallback } from "@/lib/pdf/pdf-page";
import { PDFViewport } from "@/lib/pdf/pdf-viewport";
import { sanitizeHref } from "@/lib/sanitize-href";
import { mcpConnectorsOptions } from "@/routes/_protected.knowledge/-queries";
import type { InspectorTab } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { InspectorTabHeader } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-tab-header";
import { MeasuredPdfProvider } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/measured-pdf-provider";

const SERVER_PREVIEW_ERROR_THRESHOLD = 500;

const toastedPreviewFailures = new Set<string>();

const protectedRouteApi = getRouteApi("/_protected");

export type ExternalReferencePanelProps = {
  onClose: () => void;
  tab: Extract<InspectorTab, { type: "external" }>;
  workspaceId?: string | undefined;
};

type InspectorFindOptions = {
  contentRef: RefObject<HTMLElement | null>;
  enabled: boolean;
  highlightKey: string;
};

type FindState =
  | { open: false }
  | {
      open: true;
      query: string;
      matchCount: number;
      activeIndex: number;
    };

const FIND_CLOSED: FindState = { open: false };
const FIND_OPENED: FindState = {
  open: true,
  query: "",
  matchCount: 0,
  activeIndex: 0,
};

const useInspectorFind = ({
  contentRef,
  enabled,
  highlightKey,
}: InspectorFindOptions) => {
  const [findState, setFindState] = useState<FindState>(FIND_CLOSED);
  const allHighlightName = `stella-inspector-find-${highlightKey}`;
  const activeHighlightName = `stella-inspector-find-active-${highlightKey}`;

  const clearFind = useCallback(() => {
    setFindState((prev) =>
      prev.open ? { ...prev, query: "", matchCount: 0, activeIndex: 0 } : prev,
    );
    // eslint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
    CSS.highlights?.delete(allHighlightName);
    // eslint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
    CSS.highlights?.delete(activeHighlightName);
  }, [activeHighlightName, allHighlightName]);

  const closeFind = useCallback(() => {
    setFindState(FIND_CLOSED);
  }, []);

  const openFind = useCallback(() => {
    if (!enabled) {
      return;
    }
    setFindState((prev) => (prev.open ? prev : FIND_OPENED));
  }, [enabled]);

  const setFindQuery = useCallback((query: string) => {
    setFindState((prev) => (prev.open ? { ...prev, query } : prev));
  }, []);

  const nextMatch = useCallback(() => {
    setFindState((prev) => {
      if (!prev.open || prev.matchCount === 0) {
        return prev;
      }
      return {
        ...prev,
        activeIndex: (prev.activeIndex + 1) % prev.matchCount,
      };
    });
  }, []);

  const previousMatch = useCallback(() => {
    setFindState((prev) => {
      if (!prev.open || prev.matchCount === 0) {
        return prev;
      }
      return {
        ...prev,
        activeIndex: (prev.activeIndex - 1 + prev.matchCount) % prev.matchCount,
      };
    });
  }, []);

  const findOpen = findState.open;
  const findQuery = findState.open ? findState.query : "";
  const matchCount = findState.open ? findState.matchCount : 0;
  const activeIndex = findState.open ? findState.activeIndex : 0;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!enabled) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindState((prev) => (prev.open ? prev : FIND_OPENED));
        return;
      }

      if (event.key === "Escape" && findOpen) {
        event.preventDefault();
        setFindState(FIND_CLOSED);
      }
    };

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      document.removeEventListener("keydown", handleKeyDown, { capture: true });
    };
  }, [enabled, findOpen]);

  useLayoutEffect(() => {
    // eslint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
    CSS.highlights?.delete(allHighlightName);
    // eslint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
    CSS.highlights?.delete(activeHighlightName);

    const root = contentRef.current;
    const query = findQuery.trim();
    if (!enabled || !root || query.length === 0) {
      setFindState((prev) =>
        prev.open && (prev.matchCount !== 0 || prev.activeIndex !== 0)
          ? { ...prev, matchCount: 0, activeIndex: 0 }
          : prev,
      );
      return undefined;
    }

    const ranges = collectTextRanges(root, query);
    setFindState((prev) =>
      prev.open && prev.matchCount !== ranges.length
        ? { ...prev, matchCount: ranges.length }
        : prev,
    );

    if (ranges.length === 0) {
      setFindState((prev) =>
        prev.open && prev.activeIndex !== 0
          ? { ...prev, activeIndex: 0 }
          : prev,
      );
      return undefined;
    }

    const safeActiveIndex = activeIndex >= ranges.length ? 0 : activeIndex;
    if (safeActiveIndex !== activeIndex) {
      setFindState((prev) =>
        prev.open ? { ...prev, activeIndex: safeActiveIndex } : prev,
      );
      return undefined;
    }

    // eslint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
    CSS.highlights?.set(allHighlightName, new Highlight(...ranges));
    const activeRange = ranges.at(safeActiveIndex);
    if (activeRange) {
      // eslint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
      CSS.highlights?.set(activeHighlightName, new Highlight(activeRange));
      scrollRangeIntoView(activeRange);
    }

    return () => {
      // eslint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
      CSS.highlights?.delete(allHighlightName);
      // eslint-disable-next-line typescript/no-unnecessary-condition -- CSS.highlights is not available in every supported browser.
      CSS.highlights?.delete(activeHighlightName);
    };
  }, [
    activeHighlightName,
    activeIndex,
    allHighlightName,
    contentRef,
    enabled,
    findQuery,
  ]);

  return {
    activeMatchNumber: matchCount === 0 ? 0 : activeIndex + 1,
    clearFind,
    closeFind,
    findOpen,
    findQuery,
    matchCount,
    nextMatch,
    openFind,
    previousMatch,
    setFindQuery,
  };
};

const collectTextRanges = (root: HTMLElement, query: string): Range[] => {
  const ranges: Range[] = [];
  const normalizedQuery = query.toLocaleLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent ?? "";
    const normalizedText = text.toLocaleLowerCase();
    let from = 0;

    while (from < normalizedText.length) {
      const index = normalizedText.indexOf(normalizedQuery, from);
      if (index === -1) {
        break;
      }

      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      ranges.push(range);
      from = index + Math.max(query.length, 1);
    }
  }

  return ranges;
};

const scrollRangeIntoView = (range: Range): void => {
  const rect = firstVisibleRangeRect(range);
  const root =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  const scrollContainer =
    root instanceof HTMLElement
      ? root.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
      : null;

  if (rect && scrollContainer) {
    const containerRect = scrollContainer.getBoundingClientRect();
    const targetTop =
      rect.top -
      containerRect.top +
      scrollContainer.scrollTop -
      scrollContainer.clientHeight / 2 +
      rect.height / 2;

    scrollContainer.scrollTo({
      behavior: "smooth",
      top: Math.max(0, targetTop),
    });
    return;
  }

  const container = range.commonAncestorContainer;
  const element =
    container.nodeType === Node.ELEMENT_NODE
      ? container
      : container.parentElement;
  if (element instanceof HTMLElement) {
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  }
};

const firstVisibleRangeRect = (range: Range): DOMRect | undefined => {
  for (const rect of range.getClientRects()) {
    if (rect.width > 0 && rect.height > 0) {
      return rect;
    }
  }

  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : undefined;
};

const sanitizeHighlightKey = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");

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
          className="size-3 rounded-[2px] object-contain"
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

export const findMcpConnectorIconHref = ({
  connectorSlug,
  connectors,
}: {
  connectorSlug: string;
  connectors: {
    iconUrl: string | null;
    slug: string;
    url: string;
  }[];
}): string | undefined => {
  const connector = connectors.find(
    (item) => sanitizeMcpToolNamePart(item.slug) === connectorSlug,
  );
  if (!connector) {
    return undefined;
  }

  const iconHref = connector.iconUrl ?? fallbackIconUrl(connector.url);
  return iconHref === undefined ? undefined : sanitizeHref(iconHref);
};

const sanitizeMcpToolNamePart = (value: string): string =>
  value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");

const fallbackIconUrl = (rawUrl: string): string | undefined => {
  try {
    return new URL("/favicon.ico", rawUrl).toString();
  } catch {
    return undefined;
  }
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
      // SAFETY: `enabled` below guarantees `url` is defined when the
      // queryFn runs.
      // eslint-disable-next-line typescript/no-non-null-assertion
      const response = await fetch(url!, {
        credentials: "include",
        signal,
      });

      if (!response.ok) {
        throw new FetchBoundaryError({
          // SAFETY: `enabled` below guarantees `url` is defined when the
          // queryFn runs.
          // eslint-disable-next-line typescript/no-non-null-assertion
          url: url!,
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

export const ExternalReferencePanel = ({
  onClose,
  tab,
  workspaceId,
}: ExternalReferencePanelProps) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const fallbackChatThreadIdRef = useRef(createChatThreadId());
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
  const {
    data: fetchedPreview,
    isLoading: previewLoading,
    error: previewError,
  } = useQuery({
    queryKey: ["external-preview", tab.url],
    queryFn: async ({ signal }) => {
      const response = await api["external-preview"].get({
        query: { url: tab.url },
        fetch: { signal },
      });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    enabled: shouldFetchPreview,
    retry: false,
    staleTime: 1000 * 60 * 10,
  });

  // Surface upstream-induced failures (e.g. the source returned 5xx)
  // as a toast — without this the panel just falls through to the
  // generic "preview unavailable" view and the user has no signal
  // that anything went wrong.
  //
  // Two filters keep this from being noisy:
  // 1. Only 5xx — 4xx errors (422 unsupported content type / too
  //    little readable text) are expected outcomes the fallback
  //    already handles.
  // 2. Dedupe by (url, status) across the inspector's lifetime so
  //    flipping between tabs doesn't re-toast a cached error.
  useEffect(() => {
    if (!previewError || !APIError.is(previewError)) {
      return;
    }
    if (previewError.status < SERVER_PREVIEW_ERROR_THRESHOLD) {
      return;
    }
    const key = `${tab.url}|${previewError.status}`;
    if (toastedPreviewFailures.has(key)) {
      return;
    }
    toastedPreviewFailures.add(key);
    stellaToast.add({
      title: t("common.somethingWentWrong"),
      description: previewError.message,
      type: "error",
    });
  }, [previewError, tab.url, t]);
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
      ? fallbackChatThreadIdRef.current
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
  const highlightKey = useMemo(() => sanitizeHighlightKey(tab.id), [tab.id]);
  const contentRef = useRef<HTMLElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const {
    activeMatchNumber,
    clearFind,
    closeFind,
    findOpen,
    findQuery,
    matchCount,
    nextMatch,
    openFind,
    previousMatch,
    setFindQuery,
  } = useInspectorFind({
    contentRef,
    enabled: previewText !== undefined,
    highlightKey,
  });
  const { data: mcpConnectorsData } = useQuery({
    ...mcpConnectorsOptions(activeOrganizationId),
    enabled: connectorSlug !== undefined,
  });
  const iconHref =
    storedIconHref ??
    (connectorSlug === undefined
      ? undefined
      : findMcpConnectorIconHref({
          connectorSlug,
          connectors: mcpConnectorsData?.connectors ?? [],
        }));
  const requestOpenExternal = useCallback((href: string) => {
    setConfirmHref(href);
  }, []);
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

    window.open(confirmHref, "_blank", "noopener,noreferrer");
    setConfirmHref(undefined);
  }, [confirmHref]);
  const copyConfirmHref = useCallback(async () => {
    if (confirmHref === undefined) {
      return;
    }

    try {
      await navigator.clipboard.writeText(confirmHref);
      void stellaToast.success(t("common.copied"));
    } catch {
      void stellaToast.error(t("common.error"));
    }
  }, [confirmHref, t]);

  useEffect(() => {
    if (!findOpen) {
      return;
    }
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  return (
    <div className="bg-background flex min-h-0 flex-1 flex-col overflow-hidden">
      <style>
        {`
          ::highlight(stella-inspector-find-${highlightKey}) {
            background-color: color-mix(in oklab, var(--color-primary) 22%, transparent);
            color: inherit;
          }
          ::highlight(stella-inspector-find-active-${highlightKey}) {
            background-color: color-mix(in oklab, var(--color-primary) 45%, transparent);
            color: inherit;
          }
        `}
      </style>
      <InspectorTabHeader
        actions={
          <div className="flex items-center gap-1">
            {previewText && (
              <Button
                aria-label={t("folio.findReplace.find")}
                onClick={openFind}
                size="xs"
                title="Cmd+F"
                variant="ghost"
              >
                <SearchIcon className="size-3.5" />
                {t("folio.findReplace.find")}
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
                  <span
                    className="bg-muted text-muted-foreground max-w-24 truncate rounded px-1.5 py-0.5 font-mono text-[10px]"
                    title={connectorSlug}
                  >
                    {connectorSlug}
                  </span>
                )}
                {sourceToolName && (
                  <span
                    className="bg-muted text-muted-foreground min-w-0 truncate rounded px-1.5 py-0.5 font-mono text-[10px]"
                    title={sourceToolName}
                  >
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
          {findOpen && (
            <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
              <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
              <Input
                aria-label={t("folio.findReplace.findText")}
                className="h-7 flex-1 rounded-md"
                nativeInput
                onChange={(event) => {
                  setFindQuery(event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    clearFind();
                    closeFind();
                    return;
                  }
                  if (event.key !== "Enter") {
                    return;
                  }
                  event.preventDefault();
                  if (event.shiftKey) {
                    previousMatch();
                    return;
                  }
                  nextMatch();
                }}
                placeholder={t("folio.findReplace.findPlaceholder")}
                ref={findInputRef}
                size="sm"
                type="search"
                value={findQuery}
              />
              <span className="text-muted-foreground min-w-14 text-end text-xs tabular-nums">
                {(() => {
                  if (findQuery) {
                    return (() => {
                      if (matchCount > 0) {
                        return t("folio.findReplace.matchCounter", {
                          current: String(activeMatchNumber),
                          total: String(matchCount),
                        });
                      }
                      return t("folio.findReplace.noResults");
                    })();
                  }
                  return "";
                })()}
              </span>
              <Button
                aria-label={t("folio.findReplace.previous")}
                disabled={matchCount === 0}
                onClick={previousMatch}
                size="icon-xs"
                title={t("folio.findReplace.previousShortcut")}
                variant="ghost"
              >
                <ChevronLeftIcon className="size-3.5" />
              </Button>
              <Button
                aria-label={t("folio.findReplace.next")}
                disabled={matchCount === 0}
                onClick={nextMatch}
                size="icon-xs"
                title={t("folio.findReplace.nextShortcut")}
                variant="ghost"
              >
                <ChevronRightIcon className="size-3.5" />
              </Button>
              <Button
                aria-label={t("folio.findReplace.close")}
                onClick={() => {
                  clearFind();
                  closeFind();
                }}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          )}
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
                void copyConfirmHref();
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
