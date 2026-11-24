import { useState } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import {
  type OfficeViewerFormat,
  type OfficeViewerNavigationRequest,
  type OfficeViewerSpreadsheetSelection,
  type OfficeViewerStatus,
  SilurusOfficeFileViewer,
} from "@/components/office/silurus-office-viewer";
import { useTheme } from "@/components/theme-provider";
import "@/components/office/office-file-viewer.css";

type OfficeDocumentCanvasProps = {
  documentBuffer: ArrayBuffer;
  format: OfficeViewerFormat;
  /** What the document is, so a new one starts a new viewer. */
  documentKey: string;
  navigationRequest?: OfficeViewerNavigationRequest | null;
  onNavigationApplied?: (sequence: number) => void;
  onNavigationError?: (error: Error) => void;
  onError?: (error: Error) => void;
  onSpreadsheetSelectionChange?: (
    selection: OfficeViewerSpreadsheetSelection | null,
  ) => void;
  onStatusChange?: (status: OfficeViewerStatus) => void;
  presentationPaddingBottomPx?: number;
  spreadsheetFooterHeightPx?: number;
};

/**
 * A spreadsheet or presentation drawn from its bytes, in the app's colour
 * scheme, covered while it loads and offering another attempt when it fails.
 * A stored file and a file inside a file draw through this one canvas.
 */
export const OfficeDocumentCanvas = ({
  documentBuffer,
  documentKey,
  format,
  navigationRequest = null,
  onNavigationApplied,
  onNavigationError,
  onError,
  onSpreadsheetSelectionChange,
  onStatusChange,
  presentationPaddingBottomPx,
  spreadsheetFooterHeightPx,
}: OfficeDocumentCanvasProps) => {
  const t = useTranslations();
  const { resolvedTheme } = useTheme();
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<OfficeViewerStatus>({
    type: "loading",
  });
  const reportStatus = (next: OfficeViewerStatus) => {
    setStatus(next);
    onStatusChange?.(next);
  };

  return (
    <div
      className={cn(
        "relative min-h-0 flex-1",
        format === "xlsx" && "stella-office-spreadsheet",
      )}
      data-color-scheme={resolvedTheme}
    >
      <SilurusOfficeFileViewer
        className="h-full min-h-0 w-full"
        documentBuffer={documentBuffer}
        format={format}
        key={`${documentKey}:${String(attempt)}:${String(presentationPaddingBottomPx ?? 0)}`}
        navigationRequest={navigationRequest}
        {...(onNavigationApplied === undefined ? {} : { onNavigationApplied })}
        {...(onNavigationError === undefined ? {} : { onNavigationError })}
        {...(onError === undefined ? {} : { onError })}
        {...(onSpreadsheetSelectionChange === undefined
          ? {}
          : { onSpreadsheetSelectionChange })}
        onStatusChange={reportStatus}
        {...(presentationPaddingBottomPx === undefined
          ? {}
          : { presentationPaddingBottomPx })}
        {...(spreadsheetFooterHeightPx === undefined
          ? {}
          : { spreadsheetFooterHeightPx })}
      />
      {status.type === "loading" && (
        <div className="bg-muted absolute inset-0 flex items-center justify-center">
          <span className="text-muted-foreground text-sm">
            {t("common.loading")}
          </span>
        </div>
      )}
      {status.type === "failed" && (
        <div className="bg-background absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-muted-foreground max-w-sm text-sm">
            {t("common.somethingWentWrong")}
          </p>
          <Button
            onClick={() => {
              reportStatus({ type: "loading" });
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
  );
};
