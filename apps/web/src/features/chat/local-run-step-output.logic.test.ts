import { describe, expect, test } from "bun:test";

import { chatLocalRunStepContentWindow } from "@stll/api-contract/chat-local-run-step-content";
import {
  foldLocalRunStepOutput,
  LOCAL_RUN_STEP_OUTPUT_UNREAD,
} from "@stll/api-contract/chat-local-run-step-content-view";

import { localRunStepOutputStaleTime } from "./local-run-step-output.logic";

/** The first window the API answers for a command's `text`. */
const firstWindow = (text: string, limit: number) => {
  const bytes = new TextEncoder().encode(text);
  const window = chatLocalRunStepContentWindow(bytes, 0, limit);
  return foldLocalRunStepOutput(LOCAL_RUN_STEP_OUTPUT_UNREAD, {
    state: "stored",
    kind: "command",
    totalBytes: bytes.byteLength,
    storedBytes: bytes.byteLength,
    start: window.start,
    text: new TextDecoder().decode(bytes.subarray(window.start, window.end)),
    nextStart: window.nextStart,
  });
};

describe("how long a read step stays fresh", () => {
  test("a text read whole holds; one cut short is read again", () => {
    expect(localRunStepOutputStaleTime(firstWindow("ls drafts", 64))).toBe(
      Number.POSITIVE_INFINITY,
    );
    expect(
      localRunStepOutputStaleTime(firstWindow("zsh: no such file", 5)),
    ).toBe(0);
    expect(localRunStepOutputStaleTime(undefined)).toBe(0);
    expect(localRunStepOutputStaleTime(LOCAL_RUN_STEP_OUTPUT_UNREAD)).toBe(0);
  });

  test("a step still arriving or not yet copied is read again; a settled one holds", () => {
    for (const content of [
      { state: "arriving" },
      { state: "not_copied" },
    ] as const) {
      const view = foldLocalRunStepOutput(
        LOCAL_RUN_STEP_OUTPUT_UNREAD,
        content,
      );
      expect(view).toEqual({ status: "answered", content });
      expect(localRunStepOutputStaleTime(view)).toBe(0);
    }
    for (const content of [
      { state: "not_stored" },
      { state: "run_budget_reached", kind: "diff", totalBytes: 40 },
      { state: "too_large", kind: "image", totalBytes: 12_000_000 },
    ] as const) {
      expect(
        localRunStepOutputStaleTime(
          foldLocalRunStepOutput(LOCAL_RUN_STEP_OUTPUT_UNREAD, content),
        ),
      ).toBe(Number.POSITIVE_INFINITY);
    }
  });
});
