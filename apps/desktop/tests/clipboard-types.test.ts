import { describe, expect, test } from "bun:test";

import {
  CLIPBOARD_RETENTIONS,
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
