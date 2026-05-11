import { describe, expect, test } from "bun:test";

import { normalizeLegacyRawToolInputs } from "@/api/handlers/chat/legacy-tool-compat";

describe("legacy chat tool input compatibility", () => {
  test("maps legacy create-document markdown input to source", () => {
    const parts = [
      {
        input: {
          markdown: "@title Legacy agreement",
          name: "Legacy agreement",
        },
        state: "input-available",
        toolCallId: "tool-call-1",
        type: "tool-create-document",
      },
    ];

    expect(normalizeLegacyRawToolInputs(parts)).toEqual([
      {
        input: {
          name: "Legacy agreement",
          source: "@title Legacy agreement",
        },
        state: "input-available",
        toolCallId: "tool-call-1",
        type: "tool-create-document",
      },
    ]);
  });

  test("keeps source when both current and legacy fields exist", () => {
    const parts = [
      {
        input: {
          markdown: "@title Old",
          name: "Current agreement",
          source: "@title Current",
        },
        state: "input-available",
        toolCallId: "tool-call-1",
        type: "tool-create-document",
      },
    ];

    expect(normalizeLegacyRawToolInputs(parts)).toEqual([
      {
        input: {
          name: "Current agreement",
          source: "@title Current",
        },
        state: "input-available",
        toolCallId: "tool-call-1",
        type: "tool-create-document",
      },
    ]);
  });
});
