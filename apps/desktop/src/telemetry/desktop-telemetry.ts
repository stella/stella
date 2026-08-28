import { invoke } from "@tauri-apps/api/core";

export const DESKTOP_TELEMETRY_WINDOWS = {
  clipboard: "clipboard",
  clipboardEditor: "clipboardEditor",
  main: "main",
  selfHostConnectDialog: "selfHostConnectDialog",
  takeoverDialog: "takeoverDialog",
} as const;

export const DESKTOP_TELEMETRY_OPERATIONS = {
  autostartRead: "autostartRead",
  autostartUpdate: "autostartUpdate",
  clipboardEditorClose: "clipboardEditorClose",
  clipboardEditorRead: "clipboardEditorRead",
  clipboardEditorSave: "clipboardEditorSave",
  clipboardCopy: "clipboardCopy",
  clipboardExternalOpen: "clipboardExternalOpen",
  clipboardHistoryRead: "clipboardHistoryRead",
  clipboardHistorySubscribe: "clipboardHistorySubscribe",
  clipboardHistoryUpdate: "clipboardHistoryUpdate",
  clipboardWindowHide: "clipboardWindowHide",
  render: "render",
  runtime: "runtime",
} as const;

export const DESKTOP_TELEMETRY_ERROR_CODES = {
  eventSubscriptionFailed: "eventSubscriptionFailed",
  invalidResponse: "invalidResponse",
  invokeFailed: "invokeFailed",
  reactCaught: "reactCaught",
  reactRecoverable: "reactRecoverable",
  reactUncaught: "reactUncaught",
  unhandledError: "unhandledError",
  unhandledRejection: "unhandledRejection",
  windowLabelMismatch: "windowLabelMismatch",
} as const;

/**
 * Startup spans the frontend measures. The native side owns the full list and
 * attaches the open kind; only a duration crosses IPC.
 */
export const DESKTOP_TELEMETRY_SPANS = {
  clipboardFirstPaint: "clipboardFirstPaint",
  clipboardHistoryReady: "clipboardHistoryReady",
  clipboardReopenPaint: "clipboardReopenPaint",
  clipboardShellCommit: "clipboardShellCommit",
  clipboardSnapshotRequest: "clipboardSnapshotRequest",
} as const;

type DesktopTelemetryWindow =
  (typeof DESKTOP_TELEMETRY_WINDOWS)[keyof typeof DESKTOP_TELEMETRY_WINDOWS];
type DesktopTelemetryOperation =
  (typeof DESKTOP_TELEMETRY_OPERATIONS)[keyof typeof DESKTOP_TELEMETRY_OPERATIONS];
type DesktopTelemetryErrorCode =
  (typeof DESKTOP_TELEMETRY_ERROR_CODES)[keyof typeof DESKTOP_TELEMETRY_ERROR_CODES];
export type DesktopTelemetrySpan =
  (typeof DESKTOP_TELEMETRY_SPANS)[keyof typeof DESKTOP_TELEMETRY_SPANS];

export type DesktopErrorReport = {
  code: DesktopTelemetryErrorCode;
  operation: DesktopTelemetryOperation;
  window: DesktopTelemetryWindow;
};

export type DesktopTimingReport = {
  durationMs: number;
  span: DesktopTelemetrySpan;
  window: DesktopTelemetryWindow;
};

export const reportDesktopTiming = ({
  durationMs,
  span,
  window,
}: DesktopTimingReport) => {
  // The native command accepts a deny-unknown-fields record with an integer
  // duration. Never attach clipboard data or search text.
  const report = {
    durationMs: Math.max(0, Math.round(durationMs)),
    span,
    window,
  };
  void invoke("desktop_report_timing", { report }).catch(() => undefined);
};

const reported = new Set<string>();

export const reportDesktopError = (report: DesktopErrorReport) => {
  const key = `${report.window}:${report.operation}:${report.code}`;
  if (reported.has(key)) {
    return;
  }
  reported.add(key);
  // The native command accepts a deny-unknown-fields enum record. Never pass
  // the caught value: messages, stacks, and clipboard data are not in schema.
  void invoke("desktop_report_error", { report }).catch(() => undefined);
};

export const installDesktopErrorTelemetry = (
  desktopWindow: DesktopTelemetryWindow,
) => {
  const onError = () => {
    reportDesktopError({
      code: DESKTOP_TELEMETRY_ERROR_CODES.unhandledError,
      operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
      window: desktopWindow,
    });
  };
  const onUnhandledRejection = () => {
    reportDesktopError({
      code: DESKTOP_TELEMETRY_ERROR_CODES.unhandledRejection,
      operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
      window: desktopWindow,
    });
  };
  globalThis.addEventListener("error", onError);
  globalThis.addEventListener("unhandledrejection", onUnhandledRejection);
  return () => {
    globalThis.removeEventListener("error", onError);
    globalThis.removeEventListener("unhandledrejection", onUnhandledRejection);
  };
};

export const desktopTelemetryWindowFromLabel = (
  label: string,
): DesktopTelemetryWindow => {
  switch (label) {
    case "clipboard":
      return DESKTOP_TELEMETRY_WINDOWS.clipboard;
    case "clipboard-editor":
      return DESKTOP_TELEMETRY_WINDOWS.clipboardEditor;
    case "main":
      return DESKTOP_TELEMETRY_WINDOWS.main;
    case "selfhost-connect-dialog":
      return DESKTOP_TELEMETRY_WINDOWS.selfHostConnectDialog;
    case "takeover-dialog":
      return DESKTOP_TELEMETRY_WINDOWS.takeoverDialog;
    default:
      reportDesktopError({
        code: DESKTOP_TELEMETRY_ERROR_CODES.windowLabelMismatch,
        operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
        window: DESKTOP_TELEMETRY_WINDOWS.main,
      });
      return DESKTOP_TELEMETRY_WINDOWS.main;
  }
};
