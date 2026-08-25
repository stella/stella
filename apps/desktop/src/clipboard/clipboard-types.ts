export type ClipboardSourceApp = {
  identifier: string | null;
  name: string;
};

export type ClipboardSourceAppVisual = {
  color: string | null;
  iconDataUrl: string | null;
  key: string;
};

export type ClipboardItem =
  | {
      copiedAt: string;
      groupId: string | null;
      id: string;
      name: string | null;
      plainText: string;
      sourceApp: ClipboardSourceApp | null;
      type: "text";
    }
  | {
      copiedAt: string;
      groupId: string | null;
      html: string;
      id: string;
      name: string | null;
      plainText: string;
      sourceApp: ClipboardSourceApp | null;
      type: "formattedText";
    };

export type ClipboardCaptureStatus = "active" | "paused";

export type ClipboardGroupColor =
  | "gray"
  | "blue"
  | "emerald"
  | "amber"
  | "rose"
  | "violet";

export type ClipboardGroup = {
  color: ClipboardGroupColor;
  id: string;
  name: string;
};

export type ClipboardPersistence =
  | { status: "initializing" }
  | { status: "encrypted" }
  | { status: "memoryOnly" }
  | { status: "deletionOnly" };

export type ClipboardSnapshot = {
  captureStatus: ClipboardCaptureStatus;
  groups: ClipboardGroup[];
  items: ClipboardItem[];
  persistence: ClipboardPersistence;
  sourceAppVisuals: ClipboardSourceAppVisual[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isClipboardSourceApp = (value: unknown): value is ClipboardSourceApp =>
  isRecord(value) &&
  (value["identifier"] === null || typeof value["identifier"] === "string") &&
  typeof value["name"] === "string";

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
    typeof value["id"] !== "string" ||
    (value["name"] !== null && typeof value["name"] !== "string") ||
    typeof value["plainText"] !== "string" ||
    (value["sourceApp"] !== null && !isClipboardSourceApp(value["sourceApp"]))
  ) {
    return false;
  }

  switch (value["type"]) {
    case "text":
      return true;
    case "formattedText":
      return typeof value["html"] === "string";
    default:
      return false;
  }
};

const isClipboardGroupColor = (value: unknown): value is ClipboardGroupColor =>
  value === "gray" ||
  value === "blue" ||
  value === "emerald" ||
  value === "amber" ||
  value === "rose" ||
  value === "violet";

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
    value["status"] === "encrypted" ||
    value["status"] === "memoryOnly" ||
    value["status"] === "deletionOnly"
  );
};

export type ClipboardEditorContext = {
  groups: ClipboardGroup[];
  item: ClipboardItem;
};

export const isClipboardEditorContext = (
  value: unknown,
): value is ClipboardEditorContext =>
  isRecord(value) &&
  Array.isArray(value["groups"]) &&
  value["groups"].every(isClipboardGroup) &&
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
    Array.isArray(value["sourceAppVisuals"]) &&
    value["sourceAppVisuals"].every(isClipboardSourceAppVisual)
  );
};
