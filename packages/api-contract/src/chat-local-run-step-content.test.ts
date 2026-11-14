import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import {
  CHAT_LOCAL_RUN_STEP_AWAITED_MS,
  CHAT_LOCAL_RUN_STEP_CONTENT_KINDS,
  CHAT_LOCAL_RUN_STEP_CONTENT_STATE,
  CHAT_LOCAL_RUN_STEP_CONTENT_WINDOW,
  CHAT_LOCAL_RUN_STEPS_AWAITED_MAX,
  chatLocalRunStepContentCap,
  chatLocalRunStepContentSchema,
  chatLocalRunStepContentUploadPath,
  chatLocalRunStepContentWindow,
  chatLocalRunStepsAwaitedSchema,
} from "./chat-local-run-step-content";
import { CHAT_LOCAL_RUN_STEP_MAX_BYTES } from "./chat-local-run-step-output";
import { DESKTOP_RUNNER_LIMITS } from "./desktop-runner";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) =>
  new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);

/** Every window of `bytes` in order, each read from the last one's end. */
const windowsOf = (bytes: Uint8Array, limit: number) => {
  const windows: Uint8Array[] = [];
  let start: number | null = 0;
  while (start !== null) {
    const window = chatLocalRunStepContentWindow(bytes, start, limit);
    windows.push(bytes.subarray(window.start, window.end));
    start = window.nextStart;
  }
  return windows;
};

describe("steps a run still has to send at its end", () => {
  test("an awaited step may arrive for as long as a run waits for its computer", () => {
    expect(CHAT_LOCAL_RUN_STEP_AWAITED_MS).toBe(
      DESKTOP_RUNNER_LIMITS.abandonedRunMs,
    );
  });

  test("the announcement carries step keys and a count, and nothing else", () => {
    const key = "ab".repeat(32);
    expect(
      v.parse(chatLocalRunStepsAwaitedSchema, { stepKeys: [key], more: 3 }),
    ).toEqual({ stepKeys: [key], more: 3 });
    for (const extra of [
      { stepKeys: [key], more: 0, text: "output" },
      { stepKeys: ["call-1"], more: 0 },
      {
        stepKeys: Array.from(
          { length: CHAT_LOCAL_RUN_STEPS_AWAITED_MAX + 1 },
          () => key,
        ),
        more: 0,
      },
    ]) {
      expect(v.safeParse(chatLocalRunStepsAwaitedSchema, extra).success).toBe(
        false,
      );
    }
  });
});

describe("a stored step's content", () => {
  test("windows read in order are whole characters that rejoin to the text", () => {
    assertProperty(
      "windows read in order are whole characters that rejoin to the text",
      fc.property(
        fc.string({ unit: "grapheme", maxLength: 200 }),
        fc.integer({ min: 1, max: 64 }),
        (text, limit) => {
          const windows = windowsOf(encode(text), limit);
          expect(windows.map(decode).join("")).toBe(text);
        },
      ),
    );
  });

  test("a window starting inside a character starts at that character", () => {
    const bytes = encode("a€b");
    expect(chatLocalRunStepContentWindow(bytes, 2, 10)).toEqual({
      start: 1,
      end: bytes.length,
      nextStart: null,
    });
  });

  test("a limit shorter than a character still moves past it", () => {
    const bytes = encode("€€");
    expect(chatLocalRunStepContentWindow(bytes, 0, 1)).toEqual({
      start: 0,
      end: 3,
      nextStart: 3,
    });
  });

  test("a window past the end is empty and ends the read", () => {
    expect(chatLocalRunStepContentWindow(encode("ab"), 9, 4)).toEqual({
      start: 2,
      end: 2,
      nextStart: null,
    });
  });

  test("each kind is held to its cap, an image to the larger one", () => {
    for (const kind of CHAT_LOCAL_RUN_STEP_CONTENT_KINDS) {
      expect(chatLocalRunStepContentCap(kind)).toBe(
        kind === "image"
          ? CHAT_LOCAL_RUN_STEP_MAX_BYTES.image
          : CHAT_LOCAL_RUN_STEP_MAX_BYTES.text,
      );
    }
    expect(CHAT_LOCAL_RUN_STEP_CONTENT_WINDOW.maxBytes).toBe(
      CHAT_LOCAL_RUN_STEP_MAX_BYTES.text,
    );
  });

  test("the upload path names the run and the step key only", () => {
    expect(
      chatLocalRunStepContentUploadPath(
        "0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f",
        "ab".repeat(32),
      ),
    ).toBe(
      `/v1/chat/local-runs/0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f/steps/${"ab".repeat(32)}/content`,
    );
  });

  test("an answer reads as exactly one state", () => {
    const answers: unknown[] = [
      {
        state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored,
        kind: "command",
        totalBytes: 5,
        storedBytes: 5,
        start: 0,
        text: "hello",
        nextStart: null,
      },
      {
        state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.stored,
        kind: "image",
        totalBytes: 9,
        file: {
          url: "stella://file::0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f",
          filename: "shot.png",
          mimeType: "image/png",
        },
      },
      {
        state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.tooLarge,
        kind: "image",
        totalBytes: 20_000_000,
      },
      {
        state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.runBudgetReached,
        kind: "diff",
        totalBytes: 12,
      },
      { state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.arriving },
      { state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notCopied },
      { state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notStored },
    ];
    for (const answer of answers) {
      const parsed: unknown = v.parse(chatLocalRunStepContentSchema, answer);
      expect(parsed).toEqual(answer);
    }
    // A stored text never carries a file, and an unstored step no text.
    expect(
      v.safeParse(chatLocalRunStepContentSchema, {
        state: CHAT_LOCAL_RUN_STEP_CONTENT_STATE.notStored,
        text: "x",
      }).success,
    ).toBe(false);
  });
});
