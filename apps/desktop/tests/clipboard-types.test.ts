import { describe, expect, test } from "bun:test";

import {
  CLIPBOARD_RETENTIONS,
  isClipboardCopyError,
  isClipboardEditorContext,
  isClipboardImagePreviewDataUrl,
  isClipboardItem,
  isClipboardSnapshot,
} from "../src/clipboard/clipboard-types";

const snapshotWithWelcomeStatus = (welcomeStatus: unknown) => ({
  captureStatus: "active",
  groups: [],
  items: [],
  persistence: { status: "encrypted" },
  retention: "month",
  sourceAppVisuals: [],
  welcomeStatus,
});

describe("clipboard snapshot welcome state", () => {
  test("accepts every native welcome status", () => {
    expect(isClipboardSnapshot(snapshotWithWelcomeStatus("pending"))).toBe(
      true,
    );
    expect(isClipboardSnapshot(snapshotWithWelcomeStatus("completed"))).toBe(
      true,
    );
  });

  test("rejects missing and frontend-only welcome states from IPC", () => {
    expect(isClipboardSnapshot(snapshotWithWelcomeStatus(undefined))).toBe(
      false,
    );
    expect(isClipboardSnapshot(snapshotWithWelcomeStatus("initializing"))).toBe(
      false,
    );
  });
});

describe("clipboard snapshot retention", () => {
  test("accepts every native retention and rejects unknown ones", () => {
    for (const retention of CLIPBOARD_RETENTIONS) {
      expect(
        isClipboardSnapshot({
          ...snapshotWithWelcomeStatus("completed"),
          retention,
        }),
      ).toBe(true);
    }
    for (const retention of [undefined, "forever", 30]) {
      expect(
        isClipboardSnapshot({
          ...snapshotWithWelcomeStatus("completed"),
          retention,
        }),
      ).toBe(false);
    }
  });
});

describe("clipboard copy error", () => {
  test("accepts every failed step the copy command reports", () => {
    for (const kind of ["copy", "hide", "history"]) {
      expect(isClipboardCopyError({ kind, message: "failed" })).toBe(true);
    }
  });

  test("rejects other rejection payloads", () => {
    expect(isClipboardCopyError("clipboard item no longer exists")).toBe(false);
    expect(isClipboardCopyError({ kind: "unknown", message: "failed" })).toBe(
      false,
    );
    expect(isClipboardCopyError({ kind: "copy" })).toBe(false);
  });
});

describe("clipboard image items", () => {
  const image = {
    byteSize: 2048,
    copiedAt: "2026-09-04T07:00:00.000Z",
    groupId: null,
    height: 720,
    id: "image-1",
    name: "Screenshot",
    sourceApp: null,
    type: "image",
    width: 1280,
  } as const;

  test("accepts image metadata without requiring text payloads", () => {
    expect(isClipboardItem(image)).toBe(true);
  });

  test("rejects invalid image dimensions and sizes", () => {
    expect(isClipboardItem({ ...image, byteSize: -1 })).toBe(false);
    expect(isClipboardItem({ ...image, byteSize: "2048" })).toBe(false);
    expect(isClipboardItem({ ...image, height: 0 })).toBe(false);
    expect(isClipboardItem({ ...image, width: 1.5 })).toBe(false);
  });

  test("requires the editor source visual field", () => {
    expect(isClipboardEditorContext({ groups: [], item: image })).toBe(false);
    expect(
      isClipboardEditorContext({
        groups: [],
        item: image,
        sourceAppVisual: null,
      }),
    ).toBe(true);
  });
});

describe("clipboard image preview data URLs", () => {
  test("accepts bounded PNG data URLs and rejects other content", () => {
    expect(isClipboardImagePreviewDataUrl("data:image/png;base64,AA==")).toBe(
      true,
    );
    expect(isClipboardImagePreviewDataUrl("data:image/jpeg;base64,AA==")).toBe(
      false,
    );
    expect(
      isClipboardImagePreviewDataUrl("data:image/png;base64,not valid"),
    ).toBe(false);
  });
});
