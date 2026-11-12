import { describe, expect, test } from "bun:test";

import { CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES } from "@stll/api-contract/chat-local-run-step-output";

import {
  diffLineTone,
  foldLocalRunStepOutput,
  isLocalRunStepOutputCut,
  LOCAL_RUN_STEP_OUTPUT_UNREAD,
  type LocalRunStepOutputEvent,
} from "./local-run-step-output.logic";

const fold = (events: LocalRunStepOutputEvent[]) => {
  let view = LOCAL_RUN_STEP_OUTPUT_UNREAD;
  for (const event of events) {
    view = foldLocalRunStepOutput(view, event);
  }
  return view;
};

describe("a step's output as its row shows it", () => {
  test("text arrives in order after the size, and counts the bytes kept", () => {
    expect(
      fold([
        { type: "started", totalBytes: 9 },
        { type: "text", text: "zsh: ", bytes: 5 },
        { type: "text", text: "nope", bytes: 4 },
      ]),
    ).toEqual({
      status: "shown",
      text: "zsh: nope",
      keptBytes: 9,
      totalBytes: 9,
    });
  });

  test("a run on another computer or a step with nothing kept says so", () => {
    expect(fold([{ type: "elsewhere" }])).toEqual({ status: "elsewhere" });
    expect(fold([{ type: "not-kept" }])).toEqual({ status: "not-kept" });
  });

  test("only output past the cap reads as cut", () => {
    expect(isLocalRunStepOutputCut(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES)).toBe(
      false,
    );
    expect(
      isLocalRunStepOutputCut(CHAT_LOCAL_RUN_STEP_OUTPUT_MAX_BYTES + 1),
    ).toBe(true);
  });

  test("a diff's file headers read as headers, not as changed lines", () => {
    expect(
      [
        "--- notes.md",
        "+++ notes.md",
        "@@",
        "-Rent is due monthly.",
        "+Rent is due quarterly.",
        " unchanged",
      ].map(diffLineTone),
    ).toEqual(["file", "file", "hunk", "removed", "added", "context"]);
  });
});
