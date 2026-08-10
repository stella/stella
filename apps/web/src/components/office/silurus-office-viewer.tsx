import { useRef, useState } from "react";

import type { Cell, CellRange, Row } from "@silurus/ooxml/xlsx";
import { panic } from "better-result";

import type { OfficeCitationLocator } from "@stll/api-contract";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { detached } from "@/lib/detached";
import { ClientOperationError } from "@/lib/errors/client";

export type OfficeViewerFormat = "pptx" | "xlsx";

export type OfficeViewerStatus =
  | { type: "loading" }
  | { type: "ready" }
  | { type: "failed"; error: Error };

export type OfficeViewerResourceLimits = {
  maxArchiveEntries?: number;
  maxArchiveEntryBytes?: number;
  maxTotalInflatedBytes?: number;
};

export type OfficeViewerSpreadsheetSelection = {
  cellReference: string;
  formula: string | null;
  value: string;
};

export type OfficeViewerNavigationRequest = {
  locator: OfficeCitationLocator;
  sequence: number;
};

type SilurusOfficeFileViewerProps = {
  className?: string;
  documentBuffer: ArrayBuffer;
  format: OfficeViewerFormat;
  navigationRequest?: OfficeViewerNavigationRequest | null;
  onNavigationApplied?: (sequence: number) => void;
  onError?: (error: Error) => void;
  onSpreadsheetSelectionChange?: (
    selection: OfficeViewerSpreadsheetSelection | null,
  ) => void;
  onStatusChange?: (status: OfficeViewerStatus) => void;
  presentationPaddingBottomPx?: number;
  resourceLimits?: OfficeViewerResourceLimits;
  spreadsheetFooterHeightPx?: number;
  workerTimeoutMs?: number;
};

const MEBIBYTE = 1024 * 1024;

const DEFAULT_OFFICE_VIEWER_RESOURCE_LIMITS = {
  maxArchiveEntries: 2048,
  maxArchiveEntryBytes: 64 * MEBIBYTE,
  maxTotalInflatedBytes: 192 * MEBIBYTE,
} as const satisfies OfficeViewerResourceLimits;

const DEFAULT_OFFICE_VIEWER_WORKER_TIMEOUT_MS = 60_000;

const loadPptxViewer = async () => import("@silurus/ooxml/pptx");
const loadXlsxViewer = async () => import("@silurus/ooxml/xlsx");

type ViewerInstance = {
  destroy: () => void;
};

const toError = (error: unknown): Error =>
  error instanceof Error
    ? error
    : new ClientOperationError({
        action: "load Office file",
        message: "Office viewer failed with an unknown error",
        cause: error,
      });

export const SilurusOfficeFileViewer = ({
  className,
  documentBuffer,
  format,
  navigationRequest = null,
  onNavigationApplied,
  onError,
  onSpreadsheetSelectionChange,
  onStatusChange,
  presentationPaddingBottomPx,
  resourceLimits = DEFAULT_OFFICE_VIEWER_RESOURCE_LIMITS,
  spreadsheetFooterHeightPx,
  workerTimeoutMs = DEFAULT_OFFICE_VIEWER_WORKER_TIMEOUT_MS,
}: SilurusOfficeFileViewerProps) => {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const viewerRef = useRef<OfficeNavigationViewer | null>(null);
  const viewerReadyRef = useRef(false);
  const navigationGenerationRef = useRef(0);
  const navigationQueueRef = useRef(Promise.resolve());
  const enqueueNavigation = useLatestCallback(
    (
      viewer: OfficeNavigationViewer,
      request: OfficeViewerNavigationRequest,
    ) => {
      navigationGenerationRef.current += 1;
      const generation = navigationGenerationRef.current;
      const previous = navigationQueueRef.current;
      const navigation = previous.then(async () => {
        if (generation !== navigationGenerationRef.current) {
          return;
        }
        const applied = await applyOfficeNavigation(
          viewer,
          request.locator,
          () => generation === navigationGenerationRef.current,
        );
        if (applied && generation === navigationGenerationRef.current) {
          onNavigationApplied?.(request.sequence);
        }
      });
      const observed = navigation.catch((error) => {
        if (generation === navigationGenerationRef.current) {
          onError?.(toError(error));
        }
      });
      navigationQueueRef.current = observed;
      detached(observed, "SilurusOfficeFileViewer.navigation");
    },
  );
  const navigateToLatestRequest = useLatestCallback(
    (viewer: OfficeNavigationViewer) => {
      if (navigationRequest) {
        enqueueNavigation(viewer, navigationRequest);
      }
    },
  );

  useExternalSyncEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !viewerReadyRef.current || !navigationRequest) {
      return;
    }
    enqueueNavigation(viewer, navigationRequest);
  }, [enqueueNavigation, navigationRequest]);

  useExternalSyncEffect(() => {
    if (!container) {
      return undefined;
    }

    let disposed = false;
    const loadState: { type: OfficeViewerStatus["type"] } = {
      type: "loading",
    };
    let viewer: ViewerInstance | null = null;
    let workbook: { destroy: () => void } | null = null;
    let selectionRequest = 0;
    let resolveSpreadsheetReady: (() => void) | null = null;

    const finishSpreadsheetLoad = () => {
      resolveSpreadsheetReady?.();
      resolveSpreadsheetReady = null;
    };

    onStatusChange?.({ type: "loading" });
    onSpreadsheetSelectionChange?.(null);

    const reportError = (value: unknown) => {
      if (disposed) {
        return;
      }
      const error = toError(value);
      onError?.(error);
      if (loadState.type === "loading") {
        loadState.type = "failed";
        onStatusChange?.({ error, type: "failed" });
      }
      finishSpreadsheetLoad();
    };

    const reportReady = () => {
      if (disposed || loadState.type !== "loading") {
        return;
      }
      loadState.type = "ready";
      onStatusChange?.({ type: "ready" });
    };

    const presentationViewerOptions = {
      enableHyperlinks: false,
      enableMediaPlayback: false,
      enableTextSelection: true,
      mode: "worker",
      onError: reportError,
      resourceLimits,
      useGoogleFonts: false,
      workerTimeoutMs,
      ...(presentationPaddingBottomPx === undefined
        ? {}
        : { paddingBottom: presentationPaddingBottomPx }),
    } as const;

    const load = async () => {
      if (format === "xlsx") {
        const { XlsxViewer, XlsxWorkbook } = await loadXlsxViewer();
        const loadedWorkbook = await XlsxWorkbook.load(
          documentBuffer.slice(0),
          {
            mode: "worker",
            resourceLimits,
            useGoogleFonts: false,
            workerTimeoutMs,
          },
        );
        if (disposed) {
          loadedWorkbook.destroy();
          return;
        }
        workbook = loadedWorkbook;
        let currentSheetIndex = 0;
        const spreadsheetReady = new Promise<void>((resolve) => {
          resolveSpreadsheetReady = resolve;
        });
        const reportSelection = (selection: CellRange | null) => {
          if (disposed) {
            return;
          }
          selectionRequest += 1;
          const request = selectionRequest;
          if (selection === null) {
            onSpreadsheetSelectionChange?.(null);
            return;
          }

          const sheetIndex = currentSheetIndex;
          const { col, row } = selection.active;
          detached(
            loadedWorkbook
              .getWorksheet(sheetIndex)
              .then((worksheet) => {
                if (disposed || request !== selectionRequest) {
                  return undefined;
                }
                const cell = findWorksheetCell(worksheet.rows, row, col);
                onSpreadsheetSelectionChange?.({
                  cellReference: `${toSpreadsheetColumnName(col)}${String(row)}`,
                  formula: cell?.formula ?? null,
                  value: cell ? loadedWorkbook.cellText(worksheet, cell) : "",
                });
                return undefined;
              })
              .catch(reportError),
            "SilurusOfficeFileViewer.selection",
          );
        };

        const xlsxViewer = XlsxViewer.fromWorkbook(container, loadedWorkbook, {
          enableHyperlinks: false,
          onError: reportError,
          onSelectionChange: reportSelection,
          onSheetChange: (sheetIndex) => {
            if (disposed) {
              return;
            }
            currentSheetIndex = sheetIndex;
            selectionRequest += 1;
            onSpreadsheetSelectionChange?.(null);
            markActiveSpreadsheetTab(container, sheetIndex);
            finishSpreadsheetLoad();
          },
          resizable: true,
          showZoomSlider: true,
        });
        viewer = xlsxViewer;
        viewerRef.current = { format: "xlsx", viewer: xlsxViewer };
        if (spreadsheetFooterHeightPx !== undefined) {
          setSpreadsheetFooterHeight(container, spreadsheetFooterHeightPx);
        }
        await spreadsheetReady;
      } else {
        const { PptxScrollViewer } = await loadPptxViewer();
        if (disposed) {
          return;
        }
        const pptxViewer = new PptxScrollViewer(
          container,
          presentationViewerOptions,
        );
        viewer = pptxViewer;
        viewerRef.current = { format: "pptx", viewer: pptxViewer };
        await pptxViewer.load(documentBuffer.slice(0));
      }
      viewerReadyRef.current = true;
      reportReady();
      const navigationViewer = viewerRef.current;
      if (navigationViewer) {
        navigateToLatestRequest(navigationViewer);
      }
    };

    detached(load().catch(reportError), "SilurusOfficeFileViewer.load");

    return () => {
      disposed = true;
      viewerReadyRef.current = false;
      navigationGenerationRef.current += 1;
      navigationQueueRef.current = Promise.resolve();
      selectionRequest += 1;
      finishSpreadsheetLoad();
      viewerRef.current = null;
      viewer?.destroy();
      workbook?.destroy();
      container.replaceChildren();
    };
  }, [
    container,
    documentBuffer,
    format,
    enqueueNavigation,
    navigateToLatestRequest,
    onError,
    onSpreadsheetSelectionChange,
    onStatusChange,
    presentationPaddingBottomPx,
    resourceLimits,
    spreadsheetFooterHeightPx,
    workerTimeoutMs,
  ]);

  return <div className={className} dir="ltr" ref={setContainer} />;
};

type OfficeNavigationViewer =
  | {
      format: "pptx";
      viewer: {
        scrollToSlide: (
          index: number,
          options?: { behavior?: "auto" | "smooth" },
        ) => void;
      };
    }
  | {
      format: "xlsx";
      viewer: {
        goToSheet: (index: number) => Promise<void>;
        scrollToCell: (reference: string) => Promise<void>;
        select: (reference: string) => void;
      };
    };

const applyOfficeNavigation = async (
  target: OfficeNavigationViewer,
  locator: OfficeCitationLocator,
  isCurrent: () => boolean,
): Promise<boolean> => {
  if (!isCurrent()) {
    return false;
  }
  if (target.format === "pptx" && locator.type === "pptx") {
    target.viewer.scrollToSlide(locator.slideIndex, { behavior: "smooth" });
    return true;
  }
  if (target.format === "xlsx" && locator.type === "xlsx") {
    await target.viewer.goToSheet(locator.sheetIndex);
    if (!isCurrent()) {
      return false;
    }
    target.viewer.select(locator.range);
    await target.viewer.scrollToCell(locator.range);
    return isCurrent();
  }
  return false;
};

const findWorksheetCell = (
  rows: readonly Row[],
  rowIndex: number,
  columnIndex: number,
): Cell | undefined => {
  let low = 0;
  let high = rows.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const row = rows.at(middle);
    if (!row) {
      panic("Worksheet row index is out of bounds");
    }
    if (row.index < rowIndex) {
      low = middle + 1;
      continue;
    }
    if (row.index > rowIndex) {
      high = middle - 1;
      continue;
    }

    let cellLow = 0;
    let cellHigh = row.cells.length - 1;
    while (cellLow <= cellHigh) {
      const cellMiddle = Math.floor((cellLow + cellHigh) / 2);
      const cell = row.cells.at(cellMiddle);
      if (!cell) {
        panic("Worksheet cell index is out of bounds");
      }
      if (cell.col < columnIndex) {
        cellLow = cellMiddle + 1;
        continue;
      }
      if (cell.col > columnIndex) {
        cellHigh = cellMiddle - 1;
        continue;
      }
      return cell;
    }
    return undefined;
  }
  return undefined;
};

const toSpreadsheetColumnName = (columnIndex: number) => {
  let current = columnIndex;
  let name = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCodePoint(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
};

const setSpreadsheetFooterHeight = (container: HTMLElement, height: number) => {
  if (!Number.isFinite(height) || height <= 0) {
    panic("Spreadsheet footer height must be positive");
  }

  const tabStrip = container.querySelector(".xlsx-tab-strip");
  const tabBar = tabStrip?.parentElement;
  if (!(tabStrip instanceof HTMLElement) || !(tabBar instanceof HTMLElement)) {
    panic("Silurus XLSX tab strip is missing");
  }

  tabBar.classList.add("stella-office-spreadsheet-tab-bar");
  tabBar.style.height = `${String(height)}px`;
  tabBar.style.alignItems = "center";
  const tabList = tabStrip.firstElementChild;
  if (tabList instanceof HTMLElement) {
    tabList.style.alignItems = "center";
  }
};

const markActiveSpreadsheetTab = (
  container: HTMLElement,
  activeSheetIndex: number,
) => {
  const tabStrip = container.querySelector(".xlsx-tab-strip");
  const tabList = tabStrip?.firstElementChild;
  if (!(tabList instanceof HTMLElement)) {
    panic("Silurus XLSX tab list is missing");
  }

  for (const [index, tab] of [...tabList.children].entries()) {
    tab.classList.toggle(
      "stella-office-spreadsheet-tab-active",
      index === activeSheetIndex,
    );
  }
};
