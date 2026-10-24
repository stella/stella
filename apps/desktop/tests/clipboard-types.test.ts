import { describe, expect, test } from "bun:test";

import contract from "../fixtures/clipboard-contract.json" with { type: "json" };
import { CLIPBOARD_GROUP_COLOR_PRESETS } from "../src/clipboard/clipboard-style";
import {
  CLIPBOARD_EDITOR_SESSION_EVENT,
  CLIPBOARD_HISTORY_CHANGED_EVENT,
  CLIPBOARD_RETENTIONS,
  CLIPBOARD_SCREEN_CAPTURES,
  isClipboardCaptureRevision,
  isClipboardCopyError,
  isClipboardEditorContext,
  isClipboardEditorSession,
  isClipboardGroup,
  isClipboardGroupColor,
  isClipboardImagePreviewDataUrl,
  isClipboardItem,
  isClipboardSnapshot,
} from "../src/clipboard/clipboard-types";

const snapshotWithWelcomeStatus = (welcomeStatus: unknown) => ({
  revision: 0,
  captureStatus: "active",
  groupLimit: 24,
  groups: [],
  items: [],
  persistence: { imageCleanup: "idle", status: "encrypted" },
  retention: "month",
  screenCapture: "hidden",
  sourceAppExclusionLimit: 128,
  sourceAppExclusions: [],
  sourceAppVisuals: [],
  welcomeStatus,
});

test("capture notifications contain only a bounded revision and no clip content", () => {
  for (const revision of [0, 1, 0xff_ff_ff_ff]) {
    expect(isClipboardCaptureRevision({ revision })).toBe(true);
  }
  for (const payload of [
    null,
    1,
    {},
    { revision: -1 },
    { revision: 1.5 },
    { revision: 0x1_00_00_00_00 },
    { revision: 1, item: CLIPBOARD_HISTORY_CHANGED_EVENT },
  ]) {
    expect(isClipboardCaptureRevision(payload)).toBe(false);
  }
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

describe("clipboard snapshot group limit", () => {
  test("requires a positive safe integer supplied by native", () => {
    for (const groupLimit of [
      undefined,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(
        isClipboardSnapshot({
          ...snapshotWithWelcomeStatus("completed"),
          groupLimit,
        }),
      ).toBe(false);
    }
    expect(
      isClipboardSnapshot({
        ...snapshotWithWelcomeStatus("completed"),
        groupLimit: 24,
      }),
    ).toBe(true);
  });
});

describe("clipboard snapshot source app exclusions", () => {
  test("accepts bounded exclusions and rejects malformed or over-limit lists", () => {
    expect(
      isClipboardSnapshot({
        ...snapshotWithWelcomeStatus("completed"),
        sourceAppExclusions: [
          { identifier: "com.example.editor", name: "Editor" },
        ],
      }),
    ).toBe(true);
    expect(
      isClipboardSnapshot({
        ...snapshotWithWelcomeStatus("completed"),
        sourceAppExclusions: [{ identifier: "", name: "Editor" }],
      }),
    ).toBe(false);
    expect(
      isClipboardSnapshot({
        ...snapshotWithWelcomeStatus("completed"),
        sourceAppExclusionLimit: 1,
        sourceAppExclusions: [
          { identifier: "com.example.editor", name: "Editor" },
          { identifier: "com.example.browser", name: "Browser" },
        ],
      }),
    ).toBe(false);
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

describe("clipboard snapshot screen capture", () => {
  test("accepts every native screen capture state", () => {
    for (const screenCapture of CLIPBOARD_SCREEN_CAPTURES) {
      expect(
        isClipboardSnapshot({
          ...snapshotWithWelcomeStatus("completed"),
          screenCapture,
        }),
      ).toBe(true);
    }
  });

  test("rejects missing and unknown screen capture states", () => {
    for (const screenCapture of [undefined, "on", true]) {
      expect(
        isClipboardSnapshot({
          ...snapshotWithWelcomeStatus("completed"),
          screenCapture,
        }),
      ).toBe(false);
    }
  });
});

describe("clipboard image cleanup status", () => {
  test("accepts native cleanup states and rejects missing or unknown states", () => {
    for (const imageCleanup of ["idle", "pendingRetry"]) {
      expect(
        isClipboardSnapshot({
          ...snapshotWithWelcomeStatus("completed"),
          persistence: { imageCleanup, status: "encrypted" },
        }),
      ).toBe(true);
    }
    for (const imageCleanup of [undefined, "failed"]) {
      expect(
        isClipboardSnapshot({
          ...snapshotWithWelcomeStatus("completed"),
          persistence: { imageCleanup, status: "encrypted" },
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
    groupedAt: null,
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

  test("requires the editor source visual and group limit fields", () => {
    expect(
      isClipboardEditorContext({ groupLimit: 24, groups: [], item: image }),
    ).toBe(false);
    expect(
      isClipboardEditorContext({
        groups: [],
        item: image,
        sourceAppVisual: null,
      }),
    ).toBe(false);
    expect(
      isClipboardEditorContext({
        groupLimit: 24,
        groups: [],
        item: image,
        sourceAppVisual: null,
      }),
    ).toBe(true);
  });
});

describe("clipboard group colors", () => {
  test("accepts the lowercase hex the native side normalises to", () => {
    for (const color of CLIPBOARD_GROUP_COLOR_PRESETS) {
      expect(isClipboardGroupColor(color)).toBe(true);
    }
    expect(isClipboardGroupColor("#60a5fa")).toBe(true);
  });

  test("rejects names, uppercase hex, and shorthand hex", () => {
    for (const color of ["blue", "#60A5FA", "#fff", "60a5fa", null]) {
      expect(isClipboardGroupColor(color)).toBe(false);
    }
  });

  test("rejects groups whose color is not hex", () => {
    expect(
      isClipboardGroup({ color: "blue", id: "group-1", name: "Research" }),
    ).toBe(false);
    expect(
      isClipboardGroup({ color: "#60a5fa", id: "group-1", name: "Research" }),
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

describe("clipboard events", () => {
  test("event names match the native contract", () => {
    expect(CLIPBOARD_EDITOR_SESSION_EVENT).toBe(contract.editorSessionEvent);
    expect(CLIPBOARD_HISTORY_CHANGED_EVENT).toBe(contract.historyChangedEvent);
  });

  test("accepts the editor session payloads the native side sends", () => {
    expect(isClipboardEditorSession({ session: 3, type: "open" })).toBe(true);
    expect(isClipboardEditorSession({ type: "idle" })).toBe(true);
    expect(isClipboardEditorSession({ type: "open" })).toBe(false);
    expect(isClipboardEditorSession({ session: 1.5, type: "open" })).toBe(
      false,
    );
    expect(isClipboardEditorSession({ type: "closed" })).toBe(false);
  });
});
