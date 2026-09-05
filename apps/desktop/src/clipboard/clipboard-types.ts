export type ClipboardSourcePage = {
  host: string;
  origin: string;
  url: string;
};

export type ClipboardSourceApp = {
  identifier: string | null;
  name: string;
  page: ClipboardSourcePage | null;
  /** Key into the snapshot's `sourceAppVisuals`, resolved by the desktop core. */
  visualKey: string | null;
};

export type ClipboardSourceAppVisual = {
  color: string | null;
  iconDataUrl: string | null;
  key: string;
};

const MAX_CLIPBOARD_IMAGE_PREVIEW_DATA_URL_LENGTH = 1024 * 1024;

export const isClipboardImagePreviewDataUrl = (
  value: unknown,
): value is string =>
  typeof value === "string" &&
  value.length <= MAX_CLIPBOARD_IMAGE_PREVIEW_DATA_URL_LENGTH &&
  /^data:image\/png;base64,[A-Za-z\d+/]+={0,2}$/u.test(value);

export type ClipboardItem =
  | {
      copiedAt: string;
      groupId: string | null;
      /** When the clip joined its group; groups list clips by it. */
      groupedAt: string | null;
      id: string;
      name: string | null;
      plainText: string;
      sourceApp: ClipboardSourceApp | null;
      type: "text";
    }
  | {
      copiedAt: string;
      groupId: string | null;
      groupedAt: string | null;
      html: string;
      id: string;
      name: string | null;
      plainText: string;
      sourceApp: ClipboardSourceApp | null;
      type: "formattedText";
    }
  | {
      byteSize: number;
      copiedAt: string;
      groupId: string | null;
      groupedAt: string | null;
      height: number;
      id: string;
      name: string | null;
      sourceApp: ClipboardSourceApp | null;
      type: "image";
      width: number;
    };

export type ClipboardCaptureStatus = "active" | "paused";

/** A group accent as lowercase `#rrggbb`, the shape the native side normalises to. */
export type ClipboardGroupColor = string & {
  readonly __brand: "ClipboardGroupColor";
};

export type ClipboardGroup = {
  color: ClipboardGroupColor;
  id: string;
  name: string;
};

export type ClipboardPersistence =
  | { status: "initializing" }
  | { imageCleanup: "idle" | "pendingRetry"; status: "encrypted" }
  | { status: "memoryOnly" }
  | { status: "deletionOnly" };

export type ClipboardWelcomeStatus = "initializing" | "pending" | "completed";

export const CLIPBOARD_SCREEN_CAPTURES = ["hidden", "visible"] as const;

export type ClipboardScreenCapture = (typeof CLIPBOARD_SCREEN_CAPTURES)[number];

const isClipboardScreenCapture = (
  value: unknown,
): value is ClipboardScreenCapture =>
  CLIPBOARD_SCREEN_CAPTURES.some((capture) => capture === value);

export const CLIPBOARD_RETENTIONS = ["week", "month", "year"] as const;

export type ClipboardRetention = (typeof CLIPBOARD_RETENTIONS)[number];

const isClipboardRetention = (value: unknown): value is ClipboardRetention =>
  CLIPBOARD_RETENTIONS.some((retention) => retention === value);

export type ClipboardSnapshot = {
  captureStatus: ClipboardCaptureStatus;
  groups: ClipboardGroup[];
  items: ClipboardItem[];
  persistence: ClipboardPersistence;
  retention: ClipboardRetention;
  screenCapture: ClipboardScreenCapture;
  sourceAppVisuals: ClipboardSourceAppVisual[];
  welcomeStatus: ClipboardWelcomeStatus;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isClipboardSourcePage = (value: unknown): value is ClipboardSourcePage =>
  isRecord(value) &&
  typeof value["host"] === "string" &&
  typeof value["origin"] === "string" &&
  typeof value["url"] === "string";

const isClipboardSourceApp = (value: unknown): value is ClipboardSourceApp =>
  isRecord(value) &&
  (value["identifier"] === null || typeof value["identifier"] === "string") &&
  typeof value["name"] === "string" &&
  (value["page"] === null || isClipboardSourcePage(value["page"])) &&
  (value["visualKey"] === null || typeof value["visualKey"] === "string");

const isClipboardSourceAppVisual = (
  value: unknown,
): value is ClipboardSourceAppVisual =>
  isRecord(value) &&
  (value["color"] === null ||
    (typeof value["color"] === "string" &&
      /^#[\da-f]{6}$/iu.test(value["color"]))) &&
  (value["iconDataUrl"] === null ||
    (typeof value["iconDataUrl"] === "string" &&
      value["iconDataUrl"].startsWith("data:image/png;base64,") &&
      value["iconDataUrl"].length <= 48 * 1024)) &&
  typeof value["key"] === "string";

export const isClipboardItem = (value: unknown): value is ClipboardItem => {
  if (
    !isRecord(value) ||
    typeof value["copiedAt"] !== "string" ||
    (value["groupId"] !== null && typeof value["groupId"] !== "string") ||
    (value["groupedAt"] !== null && typeof value["groupedAt"] !== "string") ||
    typeof value["id"] !== "string" ||
    (value["name"] !== null && typeof value["name"] !== "string") ||
    (value["sourceApp"] !== null && !isClipboardSourceApp(value["sourceApp"]))
  ) {
    return false;
  }

  switch (value["type"]) {
    case "text":
      return typeof value["plainText"] === "string";
    case "formattedText":
      return (
        typeof value["plainText"] === "string" &&
        typeof value["html"] === "string"
      );
    case "image": {
      const byteSize = value["byteSize"];
      const height = value["height"];
      const width = value["width"];
      if (
        typeof byteSize !== "number" ||
        typeof height !== "number" ||
        typeof width !== "number"
      ) {
        return false;
      }
      return (
        Number.isSafeInteger(byteSize) &&
        byteSize > 0 &&
        Number.isSafeInteger(width) &&
        width > 0 &&
        Number.isSafeInteger(height) &&
        height > 0
      );
    }
    default:
      return false;
  }
};

export const isClipboardGroupColor = (
  value: unknown,
): value is ClipboardGroupColor =>
  typeof value === "string" && /^#[\da-f]{6}$/u.test(value);

export const isClipboardGroup = (value: unknown): value is ClipboardGroup =>
  isRecord(value) &&
  isClipboardGroupColor(value["color"]) &&
  typeof value["id"] === "string" &&
  typeof value["name"] === "string";

const isPersistence = (value: unknown): value is ClipboardPersistence => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value["status"] === "initializing" ||
    (value["status"] === "encrypted" &&
      (value["imageCleanup"] === "idle" ||
        value["imageCleanup"] === "pendingRetry")) ||
    value["status"] === "memoryOnly" ||
    value["status"] === "deletionOnly"
  );
};

export const CLIPBOARD_COPY_ERROR_KINDS = ["copy", "hide", "history"] as const;

export type ClipboardCopyErrorKind =
  (typeof CLIPBOARD_COPY_ERROR_KINDS)[number];

/** Rejection payload of `clipboard_copy_item`; `kind` names the failed step. */
export type ClipboardCopyError = {
  kind: ClipboardCopyErrorKind;
  message: string;
};

export const isClipboardCopyError = (
  value: unknown,
): value is ClipboardCopyError =>
  isRecord(value) &&
  CLIPBOARD_COPY_ERROR_KINDS.some((kind) => kind === value["kind"]) &&
  typeof value["message"] === "string";

export type ClipboardEditorContext = {
  groups: ClipboardGroup[];
  item: ClipboardItem;
  sourceAppVisual: ClipboardSourceAppVisual | null;
};

export const isClipboardEditorContext = (
  value: unknown,
): value is ClipboardEditorContext =>
  isRecord(value) &&
  Array.isArray(value["groups"]) &&
  value["groups"].every(isClipboardGroup) &&
  (value["sourceAppVisual"] === null ||
    isClipboardSourceAppVisual(value["sourceAppVisual"])) &&
  isClipboardItem(value["item"]);

export const isClipboardSnapshot = (
  value: unknown,
): value is ClipboardSnapshot => {
  if (!isRecord(value)) {
    return false;
  }
  const captureStatus = value["captureStatus"];
  return (
    (captureStatus === "active" || captureStatus === "paused") &&
    Array.isArray(value["groups"]) &&
    value["groups"].every(isClipboardGroup) &&
    Array.isArray(value["items"]) &&
    value["items"].every(isClipboardItem) &&
    isPersistence(value["persistence"]) &&
    isClipboardRetention(value["retention"]) &&
    isClipboardScreenCapture(value["screenCapture"]) &&
    Array.isArray(value["sourceAppVisuals"]) &&
    value["sourceAppVisuals"].every(isClipboardSourceAppVisual) &&
    (value["welcomeStatus"] === "pending" ||
      value["welcomeStatus"] === "completed")
  );
};
