import { describe, expect, test } from "bun:test";

import { classifyAIError } from "@/api/lib/ai-error";
import { ChatLoopDetectedError } from "@/api/lib/errors/tagged-errors";

describe("classifyAIError", () => {
  test("maps chat loop stops to a stable stream error kind", () => {
    const error = new ChatLoopDetectedError({
      message:
        "The AI model repeated the same work and could not recover. Please try again with a narrower request.",
    });

    expect(classifyAIError(error)).toBe("loop_detected");
  });

  test("finds chat loop stops through wrapped causes", () => {
    const error = new Error("stream failed", {
      cause: new ChatLoopDetectedError({
        message:
          "The AI model repeated the same work and could not recover. Please try again with a narrower request.",
      }),
    });

    expect(classifyAIError(error)).toBe("loop_detected");
  });
});
