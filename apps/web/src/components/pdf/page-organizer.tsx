import { useMemo, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent } from "react";

import {
  draggable,
  dropTargetForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { combine } from "@atlaskit/pragmatic-drag-and-drop/utils/combine";
import { preserveOffsetOnSource } from "@atlaskit/pragmatic-drag-and-drop/utils/preserve-offset-on-source";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/utils/set-custom-native-drag-preview";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Result } from "better-result";
import {
  CopyIcon,
  CropIcon,
  DownloadIcon,
  GripVerticalIcon,
  PlusIcon,
  Redo2Icon,
  RotateCcwIcon,
  RotateCwIcon,
  SaveIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";
import { ScrollArea } from "@stll/ui/scroll-area";
import { Separator } from "@stll/ui/separator";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  withDragAnnouncementData,
  withDropAnnouncementData,
} from "@/components/drag-and-drop-live-region.logic";
import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useHydrationSafeHotkeyPlatform } from "@/hooks/use-hydration-safe-hotkey-platform";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { filesKeys, fileOptions } from "@/lib/files/queries";
import { uploadEntityVersion } from "@/lib/files/upload-entity-version";
import {
  MAX_PAGE_EDITOR_PAGES,
  MAX_PAGE_EDITOR_SOURCE_BYTES,
  MAX_PAGE_EDITOR_SOURCES,
} from "@/lib/pdf/page-editor/page-editor-protocol";
import { transformPDFInWorker } from "@/lib/pdf/page-editor/page-editor-worker-client";
import { destroyPDFDocument } from "@/lib/pdf/pdf-cleanup";
import { usePDFStore } from "@/lib/pdf/pdf-context";
import type { PageInfo } from "@/lib/pdf/pdf-context";
import { loadPDF } from "@/lib/pdf/pdf-loader";
import type { PDFDocument } from "@/lib/pdf/pdf-loader";
import { getCanvasSize, getCanvasTransform } from "@/lib/pdf/utils";
import { downloadFile } from "@/lib/utils";
import { entityVersionsKeys } from "@/lib/workspaces/queries/entity-versions";

import {
  createPageOrganizerState,
  isPageOrganizerDirty,
  reducePageOrganizer,
  type NormalizedCrop,
  type OrganizerPage,
  type PageOrganizerState,
  type PageRotation,
} from "./page-organizer.logic";

const ORIGINAL_SOURCE_ID = "original";
const PAGE_DRAG_TYPE = "pdf-page";
const THUMBNAIL_WIDTH = 176;

const isRenderCancellation = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "AbortError" || error.name === "RenderingCancelledException");

type AddedSource = {
  id: string;
  bytes: ArrayBuffer;
  document: PDFDocument;
};

type EditorOperation =
  | { type: "idle" }
  | { type: "transforming" }
  | { type: "uploading" };

type PDFPageOrganizerProps = {
  canSaveVersion: boolean;
  entityId: string;
  fieldId: string;
  fileName: string;
  onClose: () => void;
  workspaceId: string;
};

type CropMargins = {
  top: string;
  right: string;
  bottom: string;
  left: string;
};

const EMPTY_CROP_MARGINS: CropMargins = {
  top: "0",
  right: "0",
  bottom: "0",
  left: "0",
};

const CROP_LABEL_KEYS = {
  top: "cropTop",
  right: "cropRight",
  bottom: "cropBottom",
  left: "cropLeft",
} as const satisfies Record<keyof CropMargins, string>;

const normalizePDFRotation = (degrees: number): PageRotation => {
  const normalized = ((degrees % 360) + 360) % 360;
  switch (normalized) {
    case 0:
    case 90:
    case 180:
    case 270:
      return normalized;
    default:
      return 0;
  }
};

const safePDFBaseName = (fileName: string): string => {
  const withoutExtension = fileName.replace(/\.pdf$/iu, "");
  const invalidCharacters = new Set('<>:"/\\|?*');
  let safe = "";
  for (const character of withoutExtension) {
    const codePoint = character.codePointAt(0);
    safe +=
      invalidCharacters.has(character) ||
      (codePoint !== undefined && codePoint < 32)
        ? "-"
        : character;
  }
  safe = safe.trim();
  return safe.length > 0 ? safe : "document";
};

const cropFromMargins = ({
  top,
  right,
  bottom,
  left,
}: CropMargins): NormalizedCrop | null => {
  const topValue = Number(top);
  const rightValue = Number(right);
  const bottomValue = Number(bottom);
  const leftValue = Number(left);
  const values = [topValue, rightValue, bottomValue, leftValue];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    return null;
  }
  if (topValue + bottomValue >= 100 || leftValue + rightValue >= 100) {
    return null;
  }
  return {
    x: leftValue / 100,
    y: bottomValue / 100,
    width: 1 - (leftValue + rightValue) / 100,
    height: 1 - (topValue + bottomValue) / 100,
  };
};

const makeFile = (bytes: ArrayBuffer, name: string) =>
  new File([bytes], name, { type: "application/pdf" });

const withCleanup = async <T,>(
  operation: () => Promise<T>,
  cleanup: () => void,
): Promise<T> => operation().finally(cleanup);

type ConfigureThumbnailCanvasOptions = {
  canvas: HTMLCanvasElement;
  height: number;
  viewportHeight: number;
  viewportWidth: number;
  width: number;
};

const configureThumbnailCanvas = ({
  canvas,
  height,
  viewportHeight,
  viewportWidth,
  width,
}: ConfigureThumbnailCanvasOptions): void => {
  canvas.width = width;
  canvas.height = height;
  canvas.style.aspectRatio = `${viewportWidth} / ${viewportHeight}`;
};

type LoadAddedSourcesOptions = {
  canAdd: (source: AddedSource) => boolean;
  files: readonly File[];
  index?: number | undefined;
  isMounted: () => boolean;
  onAdded: (source: AddedSource) => void;
  onLimitExceeded: () => void;
  onUnsupported: () => void;
};

const loadAddedSources = async ({
  canAdd,
  files,
  index = 0,
  isMounted,
  onAdded,
  onLimitExceeded,
  onUnsupported,
}: LoadAddedSourcesOptions): Promise<void> => {
  const file = files.at(index);
  if (!file) {
    return;
  }

  const bytes = await file.arrayBuffer();
  const sourceId = crypto.randomUUID();
  const result = await loadPDF({ fileId: sourceId, buffer: bytes });
  if (Result.isError(result)) {
    throw result.error;
  }
  if (!isMounted()) {
    await destroyPDFDocument(result.value);
    return;
  }
  if (result.value.isXfa || result.value.attachmentLabels.size > 0) {
    await destroyPDFDocument(result.value);
    onUnsupported();
  } else if (!canAdd({ id: sourceId, bytes, document: result.value })) {
    await destroyPDFDocument(result.value);
    onLimitExceeded();
  } else {
    onAdded({
      id: sourceId,
      bytes,
      document: result.value,
    });
  }

  await loadAddedSources({
    canAdd,
    files,
    index: index + 1,
    isMounted,
    onAdded,
    onLimitExceeded,
    onUnsupported,
  });
};

const downloadOutput = ({
  baseName,
  output,
}: {
  baseName: string;
  output: ArrayBuffer;
}) => {
  downloadFile(
    new Blob([output], { type: "application/pdf" }),
    `${baseName}.pdf`,
  );
};

type AuthorizePDFOrganizerExportOptions = {
  fieldId: string;
  workspaceId: string;
};

const authorizePDFOrganizerExport = async ({
  fieldId,
  workspaceId,
}: AuthorizePDFOrganizerExportOptions): Promise<void> => {
  const response = await api
    .files({ workspaceId })
    .url({ fieldId })
    .get({ query: { purpose: "download" } });
  unwrapEden(response);
};

type PageThumbnailProps = {
  page: OrganizerPage;
  pageInfo: PageInfo;
};

const PageThumbnail = ({ page, pageInfo }: PageThumbnailProps) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [shouldRender, setShouldRender] = useState(false);

  useExternalSyncEffect(() => {
    if (!container || shouldRender) {
      return undefined;
    }
    if (typeof IntersectionObserver === "undefined") {
      setShouldRender(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }
        setShouldRender(true);
        observer.disconnect();
      },
      { rootMargin: "600px" },
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, shouldRender]);

  useExternalSyncEffect(() => {
    if (!canvas || pageInfo.proxy.destroyed) {
      return undefined;
    }

    const unscaled = pageInfo.proxy.getViewport({
      rotation: page.rotation,
      scale: 1,
    });
    const scale = THUMBNAIL_WIDTH / unscaled.width;
    const viewport = pageInfo.proxy.getViewport({
      rotation: page.rotation,
      scale,
    });
    const size = getCanvasSize(viewport);
    configureThumbnailCanvas({
      canvas,
      height: size.height,
      viewportHeight: viewport.height,
      viewportWidth: viewport.width,
      width: size.width,
    });
    const renderTask = pageInfo.proxy.render({
      canvas,
      viewport,
      transform: getCanvasTransform(),
    });
    detached(
      renderTask.promise.catch((error: unknown) => {
        if (!isRenderCancellation(error)) {
          throw error;
        }
      }),
      "pdf-page-organizer.render-thumbnail",
    );
    return () => renderTask.cancel();
  }, [canvas, page.rotation, pageInfo.proxy]);

  const crop = page.crop;
  const cropTop = crop ? (1 - crop.y - crop.height) * 100 : 0;

  return (
    <div
      className="bg-muted relative flex min-h-44 w-full items-center justify-center overflow-hidden rounded-sm"
      ref={setContainer}
    >
      {shouldRender && (
        <canvas
          className="bg-card block h-auto max-h-64 w-full"
          ref={setCanvas}
        />
      )}
      {crop && (
        <div
          className="border-primary pointer-events-none absolute border-2 shadow-[0_0_0_999px_rgb(0_0_0/0.42)]"
          style={{
            height: `${crop.height * 100}%`,
            insetInlineStart: `${crop.x * 100}%`,
            top: `${cropTop}%`,
            width: `${crop.width * 100}%`,
          }}
        />
      )}
    </div>
  );
};

type OrganizerPageCardProps = {
  index: number;
  isBusy: boolean;
  isSelected: boolean;
  onMove: (draggedPageId: string, targetPageId: string) => void;
  onMoveStep: (pageId: string, direction: "backward" | "forward") => void;
  onSelect: (pageId: string, range: boolean, toggle: boolean) => void;
  page: OrganizerPage;
  pageInfo: PageInfo;
};

const OrganizerPageCard = ({
  index,
  isBusy,
  isSelected,
  onMove,
  onMoveStep,
  onSelect,
  page,
  pageInfo,
}: OrganizerPageCardProps) => {
  const tPageEditor = useTranslations("workspaces.pdf.pageEditor");
  const format = useFormatter();
  const [card, setCard] = useState<HTMLElement | null>(null);
  const [handle, setHandle] = useState<HTMLButtonElement | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const handleMove = useLatestCallback(onMove);
  const pageNumber = format.number(index + 1);
  const pageLabel = tPageEditor("pageNumber", { number: pageNumber });

  useExternalSyncEffect(() => {
    if (!card || !handle) {
      return undefined;
    }
    return combine(
      draggable({
        canDrag: () => !isBusy,
        element: card,
        dragHandle: handle,
        getInitialData: () =>
          withDragAnnouncementData(
            { type: PAGE_DRAG_TYPE, pageId: page.id },
            pageLabel,
          ),
        onGenerateDragPreview: ({ location, nativeSetDragImage }) => {
          setCustomNativeDragPreview({
            nativeSetDragImage,
            getOffset: preserveOffsetOnSource({
              element: card,
              input: location.current.input,
            }),
            render: ({ container }) => {
              const clone = card.cloneNode(true);
              if (!(clone instanceof HTMLElement)) {
                return;
              }
              clone.style.width = `${card.getBoundingClientRect().width}px`;
              container.append(clone);
            },
          });
        },
      }),
      dropTargetForElements({
        element: card,
        canDrop: ({ source }) =>
          !isBusy &&
          source.data["type"] === PAGE_DRAG_TYPE &&
          source.data["pageId"] !== page.id,
        getData: () =>
          withDropAnnouncementData({}, { type: "reorder", name: pageLabel }),
        onDragEnter: () => setIsDropTarget(true),
        onDragLeave: () => setIsDropTarget(false),
        onDrop: ({ source }) => {
          setIsDropTarget(false);
          const draggedPageId = source.data["pageId"];
          if (typeof draggedPageId === "string") {
            handleMove(draggedPageId, page.id);
          }
        },
      }),
    );
  }, [card, handle, handleMove, isBusy, page.id, pageLabel]);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      onMoveStep(page.id, "backward");
    }
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      onMoveStep(page.id, "forward");
    }
  };

  return (
    <li className="relative min-w-0" ref={setCard}>
      <article
        aria-label={pageLabel}
        className={cn(
          "bg-card group relative overflow-hidden rounded-lg border p-2 shadow-xs transition",
          isSelected && "border-primary ring-primary/30 ring-2",
          isDropTarget && "ring-primary ring-2",
        )}
        dir="ltr"
      >
        <div className="absolute inset-x-2 top-2 z-10 flex items-center justify-between">
          <label
            className="bg-background/90 text-foreground flex size-11 cursor-pointer items-center justify-center rounded-md"
            htmlFor={`pdf-page-select-${page.id}`}
          >
            <Checkbox
              aria-label={tPageEditor("selectPage", {
                number: pageNumber,
              })}
              checked={isSelected}
              id={`pdf-page-select-${page.id}`}
              onCheckedChange={() => onSelect(page.id, false, true)}
            />
          </label>
          <Button
            aria-label={tPageEditor("reorderPage", {
              number: pageNumber,
            })}
            className="bg-background/90 text-foreground [:hover,[data-pressed]]:bg-background/90 size-11 cursor-grab"
            disabled={isBusy}
            onKeyDown={handleKeyDown}
            ref={setHandle}
            size="icon"
            variant="ghost"
          >
            <GripVerticalIcon />
          </Button>
        </div>
        <button
          aria-pressed={isSelected}
          className="focus-visible:ring-ring block w-full rounded-sm outline-none focus-visible:ring-2"
          onClick={(event) =>
            onSelect(page.id, event.shiftKey, event.metaKey || event.ctrlKey)
          }
          type="button"
        >
          <PageThumbnail page={page} pageInfo={pageInfo} />
        </button>
        <div className="flex items-center justify-between gap-2 px-1 pt-2 text-xs">
          <span className="font-medium">{pageLabel}</span>
          {page.rotation !== 0 && (
            <span className="text-muted-foreground">
              {format.number(page.rotation)}°
            </span>
          )}
        </div>
      </article>
    </li>
  );
};

export const PDFPageOrganizer = ({
  canSaveVersion,
  entityId,
  fieldId,
  fileName,
  onClose,
  workspaceId,
}: PDFPageOrganizerProps) => {
  const tCommon = useTranslations("common");
  const tErrors = useTranslations("errors");
  const tPageEditor = useTranslations("workspaces.pdf.pageEditor");
  const format = useFormatter();
  const hotkeyPlatform = useHydrationSafeHotkeyPlatform();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const addedSourceDocumentsRef = useRef(new Set<PDFDocument>());
  const providerPages = usePDFStore((s) => s.pages);
  const providerDocument = usePDFStore((s) => s.document);
  const attachmentCount = usePDFStore((s) => s.attachmentLabels.size);
  const { data: originalFile } = useSuspenseQuery(
    fileOptions({ workspaceId, fieldId }),
  );
  const [addedSources, setAddedSources] = useState<AddedSource[]>([]);
  const [state, setState] = useState<PageOrganizerState>(() => {
    const initialPages = [...providerPages.entries()].map(
      ([id, pageInfo], sourcePageIndex) => ({
        id,
        sourceId: ORIGINAL_SOURCE_ID,
        sourcePageIndex,
        rotation: normalizePDFRotation(pageInfo.proxy.rotate),
      }),
    );
    return createPageOrganizerState({
      pages: initialPages,
    });
  });
  const [operation, setOperation] = useState<EditorOperation>({ type: "idle" });
  const [isAddingPDF, setIsAddingPDF] = useState(false);
  const [isCloseConfirmationOpen, setIsCloseConfirmationOpen] = useState(false);
  const [isCropOpen, setIsCropOpen] = useState(false);
  const [cropMargins, setCropMargins] = useState(EMPTY_CROP_MARGINS);
  const plan = state.history.present;
  const selectedIds = new Set(state.ui.selectedPageIds);
  const isDirty = isPageOrganizerDirty(state);
  const isBusy = operation.type !== "idle" || isAddingPDF;
  const documentLimitMessage = tPageEditor("documentLimit", {
    maxPages: format.number(MAX_PAGE_EDITOR_PAGES),
    maxSources: format.number(MAX_PAGE_EDITOR_SOURCES),
  });
  const pageInfoBySource = useMemo(() => {
    const bySource = new Map<string, readonly PageInfo[]>();
    bySource.set(ORIGINAL_SOURCE_ID, [...providerPages.values()]);
    for (const source of addedSources) {
      bySource.set(source.id, [...source.document.pages.values()]);
    }
    return bySource;
  }, [addedSources, providerPages]);
  const baseName = safePDFBaseName(fileName);
  const isUnsupported =
    providerDocument?.isXfa === true ||
    attachmentCount > 0 ||
    providerPages.size > MAX_PAGE_EDITOR_PAGES ||
    originalFile.buffer.byteLength > MAX_PAGE_EDITOR_SOURCE_BYTES;

  useMountEffect(() => () => {
    isMountedRef.current = false;
    abortRef.current?.abort();
    for (const document of addedSourceDocumentsRef.current) {
      detached(
        destroyPDFDocument(document),
        "pdf-page-organizer.destroy-added-source",
      );
    }
  });

  const dispatch = (action: Parameters<typeof reducePageOrganizer>[1]) => {
    setState((current) => reducePageOrganizer(current, action));
  };

  const pageInfoFor = (page: OrganizerPage): PageInfo | undefined =>
    pageInfoBySource.get(page.sourceId)?.at(page.sourcePageIndex);

  const transform = async (requestedOutputs: string[][]) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setOperation({ type: "transforming" });
    return await withCleanup(
      async () =>
        transformPDFInWorker({
          sources: [
            { id: ORIGINAL_SOURCE_ID, bytes: originalFile.buffer },
            ...addedSources.map((source) => ({
              id: source.id,
              bytes: source.bytes,
            })),
          ],
          pages: plan.pages,
          outputs: requestedOutputs,
          signal: controller.signal,
        }),
      () => {
        abortRef.current = null;
        setOperation({ type: "idle" });
      },
    );
  };

  const runOperation = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      analytics.captureError(error);
      stellaToast.add({
        title: tErrors("actionFailed"),
        type: "error",
      });
    }
  };

  const handleAddPDFs = async (event: ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    event.target.value = "";
    if (!fileList || fileList.length === 0) {
      return;
    }
    const files = Array.from(fileList);
    if (1 + addedSources.length + files.length > MAX_PAGE_EDITOR_SOURCES) {
      stellaToast.add({
        title: documentLimitMessage,
        type: "error",
      });
      return;
    }
    const totalBytes =
      originalFile.buffer.byteLength +
      addedSources.reduce((sum, source) => sum + source.bytes.byteLength, 0) +
      files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_PAGE_EDITOR_SOURCE_BYTES) {
      stellaToast.add({
        title: tPageEditor("sourceLimit"),
        type: "error",
      });
      return;
    }

    setIsAddingPDF(true);
    let acceptedPageCount = plan.pages.length;
    let limitToastShown = false;
    await withCleanup(
      async () =>
        loadAddedSources({
          canAdd: (source) => {
            const nextPageCount =
              acceptedPageCount + source.document.pages.size;
            if (nextPageCount > MAX_PAGE_EDITOR_PAGES) {
              return false;
            }
            acceptedPageCount = nextPageCount;
            return true;
          },
          files,
          isMounted: () => isMountedRef.current,
          onAdded: (source) => {
            addedSourceDocumentsRef.current.add(source.document);
            setAddedSources((current) => [...current, source]);
            const sourcePageInfos = [...source.document.pages.values()];
            dispatch({
              type: "appendSourcePages",
              pages: sourcePageInfos.map((pageInfo, sourcePageIndex) => ({
                id: crypto.randomUUID(),
                sourceId: source.id,
                sourcePageIndex,
                rotation: normalizePDFRotation(pageInfo.proxy.rotate),
              })),
            });
          },
          onLimitExceeded: () => {
            if (limitToastShown) {
              return;
            }
            limitToastShown = true;
            stellaToast.add({
              title: documentLimitMessage,
              type: "error",
            });
          },
          onUnsupported: () => {
            stellaToast.add({
              title: tPageEditor("unsupportedPDF"),
              type: "error",
            });
          },
        }),
      () => setIsAddingPDF(false),
    );
  };

  const handleSaveVersion = async () => {
    const [bytes] = await transform([plan.pages.map((page) => page.id)]);
    if (!bytes) {
      return;
    }
    setOperation({ type: "uploading" });
    const uploadController = new AbortController();
    abortRef.current = uploadController;
    await withCleanup(
      async () => {
        await uploadEntityVersion({
          workspaceId,
          entityId,
          file: makeFile(bytes, `${baseName}.pdf`),
          signal: uploadController.signal,
        });
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: entityVersionsKeys.all({ workspaceId, entityId }),
          }),
          queryClient.invalidateQueries({ queryKey: filesKeys.all() }),
        ]);
        stellaToast.add({
          title: tPageEditor("versionSaved"),
          type: "success",
        });
        onClose();
      },
      () => {
        abortRef.current = null;
        setOperation({ type: "idle" });
      },
    );
  };

  const handleDownload = async () => {
    const pageIds =
      selectedIds.size > 0
        ? plan.pages
            .filter((page) => selectedIds.has(page.id))
            .map((page) => page.id)
        : plan.pages.map((page) => page.id);
    const [output] = await transform([pageIds]);
    if (!output) {
      return;
    }
    await authorizePDFOrganizerExport({ fieldId, workspaceId });
    downloadOutput({
      baseName:
        selectedIds.size > 0 ? `${baseName} - selected pages` : baseName,
      output,
    });
  };

  const handleMove = (draggedPageId: string, targetPageId: string) => {
    setState((current) => {
      const withSelection = current.ui.selectedPageIds.includes(draggedPageId)
        ? current
        : reducePageOrganizer(current, {
            type: "replaceSelection",
            pageIds: [draggedPageId],
          });
      return reducePageOrganizer(withSelection, {
        type: "moveSelectedBefore",
        targetPageId,
      });
    });
  };

  const handleMoveStep = (
    pageId: string,
    direction: "backward" | "forward",
  ) => {
    setState((current) => {
      const withSelection = current.ui.selectedPageIds.includes(pageId)
        ? current
        : reducePageOrganizer(current, {
            type: "replaceSelection",
            pageIds: [pageId],
          });
      return reducePageOrganizer(withSelection, {
        type: "moveSelectedStep",
        direction,
      });
    });
  };

  const requestClose = () => {
    if (isDirty) {
      setIsCloseConfirmationOpen(true);
      return;
    }
    onClose();
  };

  const crop = cropFromMargins(cropMargins);
  const downloadLabel = tPageEditor(
    selectedIds.size > 0 ? "downloadSelectedPages" : "downloadCopy",
  );
  const allPagesSelected = selectedIds.size === plan.pages.length;
  const multiSelectModifier = hotkeyPlatform === "mac" ? "Cmd" : "Ctrl";

  if (isUnsupported) {
    return (
      <div className="bg-background flex h-full flex-col">
        <header
          className={cn(
            "flex items-center justify-between border-b px-4",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <h2 className="text-sm font-medium">{tPageEditor("title")}</h2>
          <Button
            aria-label={tCommon("close")}
            onClick={onClose}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </header>
        <div className="flex flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-md space-y-2">
            <TriangleAlertIcon className="text-muted-foreground mx-auto size-8" />
            <h3 className="font-medium">{tPageEditor("unsupportedTitle")}</h3>
            <p className="text-muted-foreground text-sm">
              {tPageEditor("unsupportedDescription")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <header
        className={cn(
          "flex shrink-0 items-center gap-2 border-b px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <div className="me-auto flex min-w-0 items-baseline gap-2">
          <h2 className="truncate text-sm font-medium">
            {tPageEditor("title")}
          </h2>
          <p className="text-muted-foreground shrink-0 text-xs tabular-nums">
            {tPageEditor("pageCount", {
              count: plan.pages.length,
            })}
          </p>
        </div>
        <input
          accept="application/pdf,.pdf"
          className="sr-only"
          multiple
          onChange={(event) => {
            detached(
              runOperation(async () => await handleAddPDFs(event)),
              "pdf-page-organizer.add-pdfs",
            );
          }}
          ref={inputRef}
          type="file"
        />
        <Button
          disabled={isBusy}
          loading={isAddingPDF}
          onClick={() => inputRef.current?.click()}
          size="sm"
          variant="outline"
        >
          <PlusIcon />
          {tPageEditor("addPDF")}
        </Button>
        <Separator className="mx-1 h-6" orientation="vertical" />
        <Button
          aria-label={tCommon("close")}
          disabled={isBusy}
          onClick={requestClose}
          size="icon-sm"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className={cn(
            "flex shrink-0 items-center gap-1 border-b px-3",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          <Button
            className="-ms-2"
            disabled={isBusy}
            onClick={() => dispatch({ type: "toggleSelectAll" })}
            size="sm"
            variant="ghost"
          >
            {tPageEditor(allPagesSelected ? "deselectAll" : "selectAll")}
          </Button>
          <Separator className="mx-1 h-6" orientation="vertical" />
          <Button
            aria-label={tPageEditor("rotateLeft")}
            disabled={selectedIds.size === 0 || isBusy}
            onClick={() => dispatch({ type: "rotateSelected", degrees: -90 })}
            size="icon-sm"
            tooltip={tPageEditor("rotateLeft")}
            variant="ghost"
          >
            <RotateCcwIcon />
          </Button>
          <Button
            aria-label={tPageEditor("rotateRight")}
            disabled={selectedIds.size === 0 || isBusy}
            onClick={() => dispatch({ type: "rotateSelected", degrees: 90 })}
            size="icon-sm"
            tooltip={tPageEditor("rotateRight")}
            variant="ghost"
          >
            <RotateCwIcon />
          </Button>
          <Button
            aria-label={tPageEditor("crop")}
            disabled={selectedIds.size === 0 || isBusy}
            onClick={() => setIsCropOpen(true)}
            size="icon-sm"
            tooltip={tPageEditor("crop")}
            variant="ghost"
          >
            <CropIcon />
          </Button>
          <Button
            aria-label={tPageEditor("duplicate")}
            disabled={selectedIds.size === 0 || isBusy}
            onClick={() =>
              dispatch({
                type: "duplicateSelected",
                newPageIds: state.ui.selectedPageIds.map(() =>
                  crypto.randomUUID(),
                ),
              })
            }
            size="icon-sm"
            tooltip={tPageEditor("duplicate")}
            variant="ghost"
          >
            <CopyIcon />
          </Button>
          <Button
            aria-label={tPageEditor("delete")}
            disabled={
              selectedIds.size === 0 ||
              selectedIds.size >= plan.pages.length ||
              isBusy
            }
            onClick={() => dispatch({ type: "deleteSelected" })}
            size="icon-sm"
            tooltip={tPageEditor("delete")}
            variant="ghost"
          >
            <Trash2Icon />
          </Button>
          <div className="ms-auto flex items-center gap-1">
            <Button
              aria-label={tPageEditor("undo")}
              disabled={state.history.past.length === 0 || isBusy}
              onClick={() => dispatch({ type: "undo" })}
              size="icon-sm"
              tooltip={tPageEditor("undo")}
              variant="ghost"
            >
              <Undo2Icon />
            </Button>
            <Button
              aria-label={tPageEditor("redo")}
              disabled={state.history.future.length === 0 || isBusy}
              onClick={() => dispatch({ type: "redo" })}
              size="icon-sm"
              tooltip={tPageEditor("redo")}
              variant="ghost"
            >
              <Redo2Icon />
            </Button>
          </div>
        </div>

        <ScrollArea className="bg-muted/30 min-h-0 flex-1">
          <ol
            aria-label={tPageEditor("pages")}
            className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-2 p-4 sm:p-6"
            dir="ltr"
          >
            {plan.pages.map((page, index) => {
              const pageInfo = pageInfoFor(page);
              if (!pageInfo) {
                return null;
              }
              return (
                <OrganizerPageCard
                  index={index}
                  isBusy={isBusy}
                  isSelected={selectedIds.has(page.id)}
                  key={page.id}
                  onMove={handleMove}
                  onMoveStep={handleMoveStep}
                  onSelect={(pageId, range, toggle) => {
                    if (range) {
                      dispatch({ type: "selectRange", pageId });
                      return;
                    }
                    if (
                      !toggle &&
                      selectedIds.size > 0 &&
                      !selectedIds.has(pageId)
                    ) {
                      stellaToast.add({
                        title: tPageEditor("multiSelectHint", {
                          modifier: multiSelectModifier,
                        }),
                        type: "info",
                      });
                    }
                    dispatch(
                      toggle
                        ? { type: "toggleSelection", pageId }
                        : { type: "replaceSelection", pageIds: [pageId] },
                    );
                  }}
                  page={page}
                  pageInfo={pageInfo}
                />
              );
            })}
          </ol>
        </ScrollArea>
      </div>

      <footer
        className={cn(
          "flex shrink-0 items-center gap-3 border-t px-4",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <p className="text-muted-foreground me-auto flex max-w-2xl items-start gap-2 text-xs">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          {tPageEditor("signatureWarning")}
        </p>
        <Button
          disabled={isBusy}
          onClick={() => {
            detached(
              runOperation(handleDownload),
              "pdf-page-organizer.download",
            );
          }}
          size="sm"
          variant="outline"
        >
          <DownloadIcon />
          {downloadLabel}
        </Button>
        <Button
          disabled={!canSaveVersion || !isDirty || isBusy}
          loading={operation.type !== "idle"}
          onClick={() => {
            detached(
              runOperation(handleSaveVersion),
              "pdf-page-organizer.save-version",
            );
          }}
          size="sm"
        >
          <SaveIcon />
          {tPageEditor("saveVersion")}
        </Button>
      </footer>

      <Dialog onOpenChange={setIsCropOpen} open={isCropOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{tPageEditor("cropTitle")}</DialogTitle>
            <DialogDescription>
              {tPageEditor("cropDescription", {
                count: selectedIds.size,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4 px-6 pb-6">
            {(["top", "right", "bottom", "left"] as const).map((side) => (
              <div className="space-y-1.5" key={side}>
                <Label htmlFor={`pdf-crop-${side}`}>
                  {tPageEditor(CROP_LABEL_KEYS[side])}
                </Label>
                <Input
                  id={`pdf-crop-${side}`}
                  inputMode="decimal"
                  min="0"
                  onChange={(event) =>
                    setCropMargins((current) => ({
                      ...current,
                      [side]: event.target.value,
                    }))
                  }
                  step="0.5"
                  type="number"
                  value={cropMargins[side]}
                />
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button
              disabled={isBusy}
              onClick={() => {
                dispatch({ type: "setCrop", crop: null });
                setCropMargins(EMPTY_CROP_MARGINS);
                setIsCropOpen(false);
              }}
              variant="ghost"
            >
              {tPageEditor("resetCrop")}
            </Button>
            <DialogClose render={<Button variant="outline" />}>
              {tCommon("cancel")}
            </DialogClose>
            <Button
              disabled={crop === null || isBusy}
              onClick={() => {
                if (!crop) {
                  return;
                }
                dispatch({ type: "setCrop", crop });
                setIsCropOpen(false);
              }}
            >
              {tPageEditor("applyCrop")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        onOpenChange={setIsCloseConfirmationOpen}
        open={isCloseConfirmationOpen}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{tPageEditor("discardTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {tPageEditor("discardDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {tCommon("cancel")}
            </AlertDialogClose>
            <Button onClick={onClose} variant="destructive">
              {tPageEditor("discard")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
};
