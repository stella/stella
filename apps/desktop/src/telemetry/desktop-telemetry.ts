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

// Character classes are tested one character at a time: the redaction and the
// frame parser scan by hand so no pattern can backtrack on a hostile message.
const isIdentifierChar = (char: string) => /[\w$.]/u.test(char);
const isCodeIdentifierChar = (char: string) => /[\w$.[\]]/u.test(char);
const isFrameFileChar = (char: string) => /[\w$.-]/u.test(char);
const isFrameNameChar = (char: string) => /[\w$.<>]/u.test(char);
const isDigit = (char: string) => char >= "0" && char <= "9";
const QUOTES = new Set(['"', "'", "`"]);
const BUNDLE_SUFFIXES = [".js:", ".mjs:", ".cjs:"];

const everyChar = (value: string, predicate: (char: string) => boolean) =>
  value.length > 0 && Array.from(value).every(predicate);

const isIdentifier = (value: string, maxChars: number) =>
  value.length <= maxChars && everyChar(value, isIdentifierChar);

/**
 * Error messages quote the data they choked on, so every quoted span becomes
 * `"…"`, except single-quoted code identifiers such as `'item.sourceApp.name'`.
 * URLs and long unbroken tokens (blobs, base64) are dropped too. Mirrors the
 * native `redact_error_message`, which re-applies the same rules.
 */
export const redactErrorMessage = (message: string) => {
  let withoutQuotes = "";
  let index = 0;
  while (index < message.length) {
    const char = message.charAt(index);
    if (!QUOTES.has(char)) {
      withoutQuotes += char;
      index += 1;
      continue;
    }
    const end = message.indexOf(char, index + 1);
    if (end === -1) {
      // An unterminated quote: everything after it is content.
      withoutQuotes += '"…"';
      break;
    }
    const quoted = message.slice(index + 1, end);
    withoutQuotes +=
      char === "'" && everyChar(quoted, isCodeIdentifierChar)
        ? `'${quoted}'`
        : '"…"';
    index = end + 1;
  }
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

const digitsAt = (text: string, start: number) => {
  let end = start;
  while (end < text.length && isDigit(text.charAt(end))) {
    end += 1;
  }
  return end > start ? { end, value: text.slice(start, end) } : null;
};

/** `function@file:line:col` when a stack line names a bundle file. */
const frameFromStackLine = (line: string) => {
  const suffixes = BUNDLE_SUFFIXES.map((suffix) => ({
    at: line.indexOf(suffix),
    suffix,
  })).filter(({ at }) => at !== -1);
  const marker = suffixes.sort((left, right) => left.at - right.at).at(0);
  if (!marker) {
    return null;
  }
  const row = digitsAt(line, marker.at + marker.suffix.length);
  if (!row || line.charAt(row.end) !== ":") {
    return null;
  }
  const column = digitsAt(line, row.end + 1);
  if (!column) {
    return null;
  }
  let fileStart = marker.at;
  while (fileStart > 0 && isFrameFileChar(line.charAt(fileStart - 1))) {
    fileStart -= 1;
  }
  const file = line.slice(fileStart, marker.at + marker.suffix.length - 1);
  // The function name ends at the separator before the URL: `name@url`
  // (WebKit) or `at name (url` (Chromium); the leading `at` is not a name.
  const separator = Math.max(
    line.lastIndexOf("@", marker.at),
    line.lastIndexOf("(", marker.at),
  );
  let nameEnd = Math.max(separator, 0);
  while (nameEnd > 0 && line.charAt(nameEnd - 1) === " ") {
    nameEnd -= 1;
  }
  let nameStart = nameEnd;
  while (nameStart > 0 && isFrameNameChar(line.charAt(nameStart - 1))) {
    nameStart -= 1;
  }
  const name = line.slice(nameStart, nameEnd);
  const fn = name === "at" ? "" : name;
  return `${fn}@${file}:${row.value}:${column.value}`;
};

/**
 * Error classes whose messages the engine writes: they describe code, not
 * data, once quoted spans are redacted. Every other message (a plain `Error`,
 * a string rejection, a command failure) is replaced by a digest, so it still
 * separates failures without carrying text. Mirrors the native allowlist.
 */
const ENGINE_ERROR_CLASSES = new Set([
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "DOMException",
]);

// A 64-bit polynomial rolling hash over the UTF-8 bytes (FNV's offset and
// prime, multiply-add instead of xor so no bitwise operators are needed).
const DIGEST_SEED = 14_695_981_039_346_656_037n;
const DIGEST_PRIME = 1_099_511_628_211n;
const DIGEST_MODULUS = 18_446_744_073_709_551_616n;
const textEncoder = new TextEncoder();

/** 16 hex digits identifying a message without carrying it; the native side computes the same. */
export const messageDigest = (message: string) => {
  let hash = DIGEST_SEED;
  for (const byte of textEncoder.encode(message)) {
    hash = (hash * DIGEST_PRIME + BigInt(byte)) % DIGEST_MODULUS;
  }
  return `poly64:${hash.toString(16).padStart(16, "0")}`;
};

const reportableMessage = (errorName: string, message: string) =>
  ENGINE_ERROR_CLASSES.has(errorName)
    ? redactErrorMessage(message)
    : messageDigest(message);

const errorFrame = (stack: string | undefined) => {
  if (!stack) {
    return null;
  }
  for (const line of stack.split("\n")) {
    const frame = frameFromStackLine(line);
    if (frame) {
      return frame;
    }
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The redacted shape of a thrown or rejected value. */
export const describeError = (value: unknown): DesktopErrorDetail => {
  if (value instanceof Error) {
    const errorName = isIdentifier(value.name, MAX_ERROR_NAME_CHARS)
      ? value.name
      : "Error";
    return {
      errorName,
      frame: errorFrame(value.stack),
      message: reportableMessage(errorName, value.message),
    };
  }
  if (typeof value === "string") {
    return { errorName: "string", frame: null, message: messageDigest(value) };
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
      message: typeof message === "string" ? messageDigest(message) : "",
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
  // different rejections under the same code apart, string rejections by
  // their digest.
  const key = [
    report.window,
    report.operation,
    report.code,
    report.detail?.errorName ?? "",
    report.detail?.frame ?? "",
    report.detail?.message ?? "",
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
