import { useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { useExternalSyncEffect } from "@stll/ui/effects";
import { Input } from "@stll/ui/input";
import { stellaToast } from "@stll/ui/toast";
import { contentDir } from "@stll/ui/use-content-dir";

import { FileViewerWithAI } from "@/components/ai-suggestions/file-viewer-with-ai";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import {
  type DesktopOpenTarget,
  useDesktopFileOpen,
} from "@/components/inspector/use-desktop-file-open";
import { OfficeDocumentCanvas } from "@/components/office/office-document-canvas";
import {
  INITIAL_OFFICE_EDIT_INTENT_STATE,
  isOfficeEditIntentKey,
  registerOfficeEditIntentKeystroke,
} from "@/components/office/office-edit-intent";
import type {
  OfficeViewerFormat,
  OfficeViewerNavigationRequest,
  OfficeViewerSpreadsheetSelection,
  OfficeViewerStatus,
} from "@/components/office/silurus-office-viewer";
import {
  DesktopRequiredDialog,
  useDesktopActionGate,
} from "@/features/desktop/desktop-action-gate";
import { useAnalytics } from "@/lib/analytics/provider";
import { TOOLBAR_ROW_HEIGHT_PX } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { registerOfficeCitationNavigation } from "@/lib/files/office-citations";
import { fileOptions } from "@/lib/files/queries";
import { useActionCapabilities } from "@/lib/organization/feature-access/capability-actions";

const OFFICE_AI_DOCK_CLEARANCE_PX = 96;
const PRESENTATION_TRAILING_PADDING_PX = 112;
const SPREADSHEET_FORMULA_SYMBOL = "fx";

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
  const desktopGate = useDesktopActionGate("edit-file");
  const desktopCapability =
    useActionCapabilities("desktop").capabilities.desktop;
  const editIntentStateRef = useRef(INITIAL_OFFICE_EDIT_INTENT_STATE);
  const navigationSequenceRef = useRef(0);
  const [viewerStatus, setViewerStatus] = useState<OfficeViewerStatus>({
    type: "loading",
  });
  const [spreadsheetSelection, setSpreadsheetSelection] =
    useState<OfficeViewerSpreadsheetSelection | null>(null);
  const [navigationRequest, setNavigationRequest] =
    useState<OfficeViewerNavigationRequest | null>(null);
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
  const handleStatusChange = (status: OfficeViewerStatus) => {
    setViewerStatus(status);
  };
  const handleViewerError = (error: Error) => {
    analytics.captureError(error, {
      fingerprintKey: "OfficeFileViewer:failure",
      scope: { type: "handler", handlerId: "OfficeFileViewer:failure" },
    });
  };
  const handleNavigationError = (error: Error) => {
    analytics.captureError(error, {
      fingerprintKey: "OfficeFileViewer:failure-2",
      scope: { type: "handler", handlerId: "OfficeFileViewer:failure-2" },
    });
    notifyUserError(error, t("errors.actionFailed"));
  };
  const handleNavigationApplied = (sequence: number) => {
    setNavigationRequest((current) =>
      current?.sequence === sequence ? null : current,
    );
  };
  const handleEditIntentKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ) => {
    if (
      desktopCapability.type !== "available" ||
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
        label: desktopGate.label,
        onClick: () => {
          desktopGate.run(() => {
            detached(openInDesktop(), "office-file-viewer.open-in-desktop");
          });
        },
      },
      description: t("workspaces.files.desktopEdit.editLocallyPrompt"),
      timeout: 10_000,
      title: t("workspaces.files.desktopEdit.action"),
      type: "info",
    });
  };
  const handleViewerPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.currentTarget.focus({ preventScroll: true });
  };

  useExternalSyncEffect(
    () =>
      registerOfficeCitationNavigation({
        entityId,
        fieldId,
        navigate: ({ locator }) => {
          navigationSequenceRef.current += 1;
          setNavigationRequest({
            locator,
            sequence: navigationSequenceRef.current,
          });
        },
      }),
    [entityId, fieldId],
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
      <DesktopRequiredDialog {...desktopGate.requiredDialog} />
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
              {SPREADSHEET_FORMULA_SYMBOL}
            </span>
            <div className="text-foreground has-focus-visible:ring-ring flex h-full min-w-0 flex-1 px-2 font-mono has-focus-visible:ring-2 has-focus-visible:ring-inset">
              <Input
                aria-label={t("common.formula")}
                className="flex h-full w-full"
                dir={contentDir(formulaBarValue)}
                readOnly
                unstyled
                value={formulaBarValue}
              />
            </div>
          </div>
        )}
        <OfficeDocumentCanvas
          documentBuffer={fileQuery.data.buffer}
          documentKey={fieldId}
          format={format}
          navigationRequest={navigationRequest}
          onNavigationApplied={handleNavigationApplied}
          onNavigationError={handleNavigationError}
          onError={handleViewerError}
          onSpreadsheetSelectionChange={setSpreadsheetSelection}
          onStatusChange={handleStatusChange}
          presentationPaddingBottomPx={PRESENTATION_TRAILING_PADDING_PX}
          spreadsheetFooterHeightPx={TOOLBAR_ROW_HEIGHT_PX}
        />
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
