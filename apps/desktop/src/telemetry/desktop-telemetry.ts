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

/**
 * What went wrong, never what the user was working on. Messages are redacted
 * here and again natively (the trust boundary), so clipboard text, search
 * terms and document content cannot ride along in an error report.
 */
export type DesktopErrorDetail = {
  /** The thrown value's class (`TypeError`), or its type for non-errors. */
  errorName: string;
  message: string;
  /** `function@file:line:col` of the top frame; bundle file names only. */
  frame: string | null;
};

export type DesktopErrorReport = {
  code: DesktopTelemetryErrorCode;
  detail?: DesktopErrorDetail;
  operation: DesktopTelemetryOperation;
  window: DesktopTelemetryWindow;
};

const MAX_ERROR_NAME_CHARS = 64;
const MAX_ERROR_MESSAGE_CHARS = 200;
const MAX_TOKEN_CHARS = 48;
/** Distinct failures reported per window before further reports are dropped. */
const MAX_REPORTED_ERRORS = 50;

const isIdentifier = (value: string, maxChars: number) =>
  value.length > 0 && value.length <= maxChars && /^[\w$.]+$/u.test(value);

/**
 * Error messages quote the data they choked on, so every quoted span becomes
 * `"…"`, except single-quoted code identifiers such as `'item.sourceApp.name'`.
 * URLs and long unbroken tokens (blobs, base64) are dropped too. Mirrors the
 * native `redact_error_message`, which re-applies the same rules.
 */
export const redactErrorMessage = (message: string) => {
  const withoutQuotes = message.replace(
    /(["'`])(.*?)\1|(["'`]).*$/gsu,
    (_match, quote: string | undefined, quoted: string | undefined) =>
      quote === "'" && quoted !== undefined && /^[\w$.[\]]+$/u.test(quoted)
        ? `'${quoted}'`
        : '"…"',
  );
  const collapsed = withoutQuotes
    .split(/\s+/u)
    .filter(Boolean)
    .map((token) => {
      if (token.startsWith("http://") || token.startsWith("https://")) {
        return "<url>";
      }
      return token.length > MAX_TOKEN_CHARS ? "…" : token;
    })
    .join(" ");
  return collapsed.length > MAX_ERROR_MESSAGE_CHARS
    ? `${collapsed.slice(0, MAX_ERROR_MESSAGE_CHARS)}…`
    : collapsed;
};

/** `function@file:line:col` for the first stack line that names a bundle file. */
const errorFrame = (stack: string | undefined) => {
  if (!stack) {
    return null;
  }
  for (const line of stack.split("\n")) {
    const location = /([\w$.-]+\.[cm]?js):(\d+):(\d+)/u.exec(line);
    if (!location) {
      continue;
    }
    const [, file, row, column] = location;
    const fn = /^\s*(?:at\s+)?([\w$.<>]+)?\s*[@(]/u.exec(line)?.[1] ?? "";
    return `${fn}@${file}:${row}:${column}`;
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The redacted shape of a thrown or rejected value. */
export const describeError = (value: unknown): DesktopErrorDetail => {
  if (value instanceof Error) {
    return {
      errorName: isIdentifier(value.name, MAX_ERROR_NAME_CHARS)
        ? value.name
        : "Error",
      frame: errorFrame(value.stack),
      message: redactErrorMessage(value.message),
    };
  }
  if (typeof value === "string") {
    return {
      errorName: "string",
      frame: null,
      message: redactErrorMessage(value),
    };
  }
  if (isRecord(value)) {
    // Native command rejections are `{ kind, message }` records.
    const kind = value["kind"] ?? value["code"];
    const errorName =
      typeof kind === "string" && isIdentifier(kind, MAX_ERROR_NAME_CHARS)
        ? `object.${kind}`
        : "object";
    const message = value["message"];
    return {
      errorName,
      frame: null,
      message: typeof message === "string" ? redactErrorMessage(message) : "",
    };
  }
  return {
    errorName: value === null ? "null" : typeof value,
    frame: null,
    message: "",
  };
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
  // Each distinct failure reports once per window; the detail keeps two
  // different rejections under the same code apart.
  const key = [
    report.window,
    report.operation,
    report.code,
    report.detail?.errorName ?? "",
    report.detail?.frame ?? "",
  ].join(":");
  if (reported.has(key) || reported.size >= MAX_REPORTED_ERRORS) {
    return;
  }
  reported.add(key);
  // The native command accepts a deny-unknown-fields record. The caught value
  // itself never crosses: only its redacted `describeError` shape does.
  void invoke("desktop_report_error", { report }).catch(() => undefined);
};

export const installDesktopErrorTelemetry = (
  desktopWindow: DesktopTelemetryWindow,
) => {
  const onError = (event: ErrorEvent) => {
    const detail: DesktopErrorDetail =
      event.error === undefined
        ? {
            errorName: "ErrorEvent",
            frame: event.filename
              ? `@${event.filename.split("/").at(-1) ?? ""}:${event.lineno}:${event.colno}`
              : null,
            message: redactErrorMessage(event.message),
          }
        : describeError(event.error);
    reportDesktopError({
      code: DESKTOP_TELEMETRY_ERROR_CODES.unhandledError,
      detail,
      operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
      window: desktopWindow,
    });
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    reportDesktopError({
      code: DESKTOP_TELEMETRY_ERROR_CODES.unhandledRejection,
      detail: describeError(event.reason),
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
