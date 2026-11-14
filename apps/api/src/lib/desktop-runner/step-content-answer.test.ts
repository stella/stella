import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { chatLocalRunStepContentSchema } from "@stll/api-contract/chat-local-run-step-content";

import { toSafeId } from "@/api/lib/branded-types";
import { stepContentAnswer } from "@/api/lib/desktop-runner/step-content-answer";
import type { StoredStepContent } from "@/api/lib/desktop-runner/step-contents";

const whole = { start: 0, limit: 1024 };

const text = (value: string): StoredStepContent => ({
  type: "text",
  kind: "command",
  totalBytes: Buffer.byteLength(value) + 5,
  storedBytes: Buffer.byteLength(value),
  text: value,
});

describe("one read of a stored step", () => {
  test("every stored outcome answers in the contract's shape", () => {
    const outcomes: StoredStepContent[] = [
      { type: "arriving" },
      { type: "not_copied" },
      { type: "not_stored" },
      { type: "unstored", state: "too_large", kind: "image", totalBytes: 9 },
      {
        type: "unstored",
        state: "run_budget_reached",
        kind: "diff",
        totalBytes: 9,
      },
      text("line\n"),
      {
        type: "image",
        totalBytes: 9,
        file: {
          id: toSafeId<"userFile">("0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f"),
          fileName: "shot.png",
          mimeType: "image/png",
          placeholder: null,
        },
      },
    ];
    for (const outcome of outcomes) {
      const answer = stepContentAnswer(outcome, whole);
      expect(v.parse(chatLocalRunStepContentSchema, answer)).toEqual(answer);
    }
  });

  test("a text is answered in windows that rejoin to what is stored", () => {
    const stored = "první řádek\ndruhý řádek ✓\n";
    let start: number | null = 0;
    let joined = "";
    while (start !== null) {
      const answer = stepContentAnswer(text(stored), { start, limit: 7 });
      if (answer.state !== "stored" || answer.kind === "image") {
        panic("expected a stored text");
      }
      expect(answer.start).toBe(start);
      expect(answer.storedBytes).toBe(Buffer.byteLength(stored));
      expect(answer.totalBytes).toBe(Buffer.byteLength(stored) + 5);
      joined += answer.text;
      start = answer.nextStart;
    }
    expect(joined).toBe(stored);
  });

  test("a window keeps a byte order mark it starts with", () => {
    const stored = "\uFEFFfirst\uFEFFsecond";
    const first = stepContentAnswer(text(stored), { start: 0, limit: 8 });
    const second = stepContentAnswer(text(stored), { start: 8, limit: 64 });
    if (
      first.state !== "stored" ||
      first.kind === "image" ||
      second.state !== "stored" ||
      second.kind === "image"
    ) {
      panic("expected stored text");
    }
    expect(first.text).toBe("\uFEFFfirst");
    expect(second.text).toBe("\uFEFFsecond");
  });

  test("an image names its chat file and carries no text", () => {
    const id = toSafeId<"userFile">("0b6f5c8e-2d3a-4f1b-9c7e-5a4d3b2c1e0f");
    expect(
      stepContentAnswer(
        {
          type: "image",
          totalBytes: 12,
          file: {
            id,
            fileName: "shot.png",
            mimeType: "image/png",
            placeholder: "data:image/png;base64,AA==",
          },
        },
        whole,
      ),
    ).toEqual({
      state: "stored",
      kind: "image",
      totalBytes: 12,
      file: {
        url: `stella://file::${id}`,
        filename: "shot.png",
        mimeType: "image/png",
        placeholder: "data:image/png;base64,AA==",
      },
    });
  });

  test("a row whose kind the contract does not know is a defect, not a guess", () => {
    expect(() =>
      stepContentAnswer(
        { type: "unstored", state: "too_large", kind: "video", totalBytes: 1 },
        whole,
      ),
    ).toThrow("unknown kind");
  });
});
