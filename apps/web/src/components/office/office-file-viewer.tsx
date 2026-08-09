import { useCallback, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";
import { contentDir } from "@stll/ui/hooks/use-content-dir";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import {
  type DesktopOpenTarget,
  useDesktopFileOpen,
} from "@/components/inspector/use-desktop-file-open";
import {
  INITIAL_OFFICE_EDIT_INTENT_STATE,
  isOfficeEditIntentKey,
  registerOfficeEditIntentKeystroke,
} from "@/components/office/office-edit-intent";
import type {
  OfficeViewerFormat,
  OfficeViewerSpreadsheetSelection,
  OfficeViewerStatus,
} from "@/components/office/silurus-office-viewer";
import { SilurusOfficeFileViewer } from "@/components/office/silurus-office-viewer";
import { useTheme } from "@/components/theme-provider";
import { useAnalytics } from "@/lib/analytics/provider";
import { TOOLBAR_ROW_HEIGHT_PX } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { fileOptions } from "@/lib/files/queries";
import "@/components/office/office-file-viewer.css";

const OFFICE_AI_DOCK_CLEARANCE_PX = 96;
const PRESENTATION_TRAILING_PADDING_PX = 112;

type OfficeFileViewerProps = {
  desktopEditTarget: Pick<DesktopOpenTarget, "fileType" | "propertyId"> | null;
  entityId: string;
  fieldId: string;
  fileName: string;
  format: OfficeViewerFormat;
  workspaceId: string;
};

export const OfficeFileViewer = ({
  desktopEditTarget,
  entityId,
  fieldId,
  fileName,
  format,
  workspaceId,
}: OfficeFileViewerProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const { resolvedTheme } = useTheme();
  const editIntentStateRef = useRef(INITIAL_OFFICE_EDIT_INTENT_STATE);
  const [attempt, setAttempt] = useState(0);
  const [viewerStatus, setViewerStatus] = useState<OfficeViewerStatus>({
    type: "loading",
  });
  const [spreadsheetSelection, setSpreadsheetSelection] =
    useState<OfficeViewerSpreadsheetSelection | null>(null);
  const fileQuery = useQuery({
    ...fileOptions({ workspaceId, fieldId, purpose: "native-display" }),
  });
  const { open: openInDesktop } = useDesktopFileOpen(
    desktopEditTarget === null
      ? null
      : { entityId, workspaceId, ...desktopEditTarget },
  );
  const requestDesktopOpenAttention = useInspectorCommandStore(
    (state) => state.requestDesktopOpenAttention,
  );
  const handleStatusChange = useCallback(
    (status: OfficeViewerStatus) => {
      if (status.type === "failed") {
        analytics.captureError(status.error);
      }
      setViewerStatus(status);
    },
    [analytics],
  );
  const handleEditIntentKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (
        desktopEditTarget === null ||
        viewerStatus.type !== "ready" ||
        !isOfficeEditIntentKey(event.nativeEvent)
      ) {
        return;
      }

      const result = registerOfficeEditIntentKeystroke({
        state: editIntentStateRef.current,
        timestamp: event.timeStamp,
      });
      editIntentStateRef.current = result.state;
      if (!result.shouldPrompt) {
        return;
      }

      requestDesktopOpenAttention(fieldId);
      stellaToast.add({
        action: {
          label: t("workspaces.files.desktopEdit.action"),
          onClick: () => {
            detached(openInDesktop(), "OfficeFileViewer");
          },
        },
        description: t("workspaces.files.desktopEdit.editLocallyPrompt"),
        timeout: 10_000,
        title: t("workspaces.files.desktopEdit.action"),
        type: "info",
      });
    },
    [
      desktopEditTarget,
      fieldId,
      openInDesktop,
      requestDesktopOpenAttention,
      t,
      viewerStatus.type,
    ],
  );
  const handleViewerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      event.currentTarget.focus({ preventScroll: true });
    },
    [],
  );

  if (fileQuery.error) {
    throw fileQuery.error;
  }

  if (!fileQuery.data) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-sm">
        {t("common.loading")}
      </div>
    );
  }

  const formulaBarValue = getFormulaBarValue(spreadsheetSelection);

  return (
    <FileViewerWithAI
      activeFile={{ entityId, fileFieldId: fieldId, fileName }}
      workspaceId={workspaceId}
    >
      <div
        aria-label={fileName}
        className="bg-muted flex h-full min-h-0 w-full flex-col overflow-hidden outline-none"
        onKeyDownCapture={handleEditIntentKeyDown}
        onPointerDownCapture={handleViewerPointerDown}
        role="document"
        style={
          format === "xlsx"
            ? { paddingBlockEnd: OFFICE_AI_DOCK_CLEARANCE_PX }
            : undefined
        }
        tabIndex={-1}
      >
        {format === "xlsx" && (
          <div
            className="bg-background flex h-9 shrink-0 items-center border-b text-xs"
            dir="ltr"
          >
            <output className="text-muted-foreground w-20 shrink-0 border-e px-2 text-center font-mono tabular-nums">
              {spreadsheetSelection?.cellReference ?? ""}
            </output>
            <span
              aria-hidden="true"
              className="text-muted-foreground px-3 font-serif text-sm italic"
            >
              {/* oxlint-disable-next-line no-untranslated-jsx-literal/no-untranslated-jsx-literal -- conventional formula-bar symbol */}
              fx
            </span>
            <input
              aria-label={t("common.formula")}
              className="text-foreground focus-visible:ring-ring h-full min-w-0 flex-1 bg-transparent px-2 font-mono outline-none focus-visible:ring-2 focus-visible:ring-inset"
              dir={contentDir(formulaBarValue)}
              readOnly
              value={formulaBarValue}
            />
          </div>
        )}
        <div
          className={
            format === "xlsx"
              ? "stella-office-spreadsheet relative min-h-0 flex-1"
              : "relative min-h-0 flex-1"
          }
          data-color-scheme={resolvedTheme}
        >
          <SilurusOfficeFileViewer
            className="h-full min-h-0 w-full"
            documentBuffer={fileQuery.data.buffer}
            format={format}
            key={`${fieldId}:${String(attempt)}:${String(PRESENTATION_TRAILING_PADDING_PX)}`}
            onSpreadsheetSelectionChange={setSpreadsheetSelection}
            onStatusChange={handleStatusChange}
            presentationPaddingBottomPx={PRESENTATION_TRAILING_PADDING_PX}
            spreadsheetFooterHeightPx={TOOLBAR_ROW_HEIGHT_PX}
          />
          {viewerStatus.type === "loading" && (
            <div className="bg-muted absolute inset-0 flex items-center justify-center">
              <span className="text-muted-foreground text-sm">
                {t("common.loading")}
              </span>
            </div>
          )}
          {viewerStatus.type === "failed" && (
            <div className="bg-background absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-muted-foreground max-w-sm text-sm">
                {t("common.somethingWentWrong")}
              </p>
              <Button
                onClick={() => {
                  setViewerStatus({ type: "loading" });
                  setAttempt((current) => current + 1);
                }}
                size="xs"
                variant="secondary"
              >
                {t("common.retry")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </FileViewerWithAI>
  );
};

const getFormulaBarValue = (
  selection: OfficeViewerSpreadsheetSelection | null,
) => {
  if (!selection?.formula) {
    return selection?.value ?? "";
  }
  if (selection.formula.startsWith("=")) {
    return selection.formula;
  }
  return `=${selection.formula}`;
};
