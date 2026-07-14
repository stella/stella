import { describe, expect, test } from "bun:test";

import { shouldShowPromptBarBusyPlaceholder } from "./host.logic";

describe("prompt bar busy placeholder", () => {
  test("leaves a queue-capable composer editable while generating", () => {
    expect(
      shouldShowPromptBarBusyPlaceholder({
        isEmpty: true,
        queueWhileGenerating: true,
        status: "generating",
      }),
    ).toBe(false);
  });

  test("shows progress when the composer cannot queue", () => {
    expect(
      shouldShowPromptBarBusyPlaceholder({
        isEmpty: true,
        queueWhileGenerating: false,
        status: "generating",
      }),
    ).toBe(true);
  });

  test("shows progress while edits are being applied", () => {
    expect(
      shouldShowPromptBarBusyPlaceholder({
        isEmpty: true,
        queueWhileGenerating: true,
        status: "applying",
      }),
    ).toBe(true);
  });

  test("does not cover an existing draft", () => {
    expect(
      shouldShowPromptBarBusyPlaceholder({
        isEmpty: false,
        queueWhileGenerating: false,
        status: "generating",
      }),
    ).toBe(false);
  });
});
