import { describe, expect, test } from "bun:test";

import { isClipboardSnapshot } from "../src/clipboard/clipboard-types";

const snapshotWithWelcomeStatus = (welcomeStatus: unknown) => ({
  captureStatus: "active",
  groups: [],
  items: [],
  persistence: { status: "encrypted" },
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
