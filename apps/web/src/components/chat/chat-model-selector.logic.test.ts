import { describe, expect, test } from "bun:test";

import { modelSelectionLabel } from "@/components/chat/chat-model-selector.logic";

describe("modelSelectionLabel", () => {
  test("shows a compact friendly model name and thinking level", () => {
    expect(
      modelSelectionLabel({
        defaultEffortLabel: "Default",
        displayName: "Claude Opus 5",
        reasoningEffort: "high",
        translateEffort: (effort) =>
          effort === "high" ? "High" : "Unexpected",
      }),
    ).toBe("Opus 5 High");
  });

  test("keeps non-Claude friendly names intact", () => {
    expect(
      modelSelectionLabel({
        defaultEffortLabel: "Default",
        displayName: "GPT-5.6 Terra",
        reasoningEffort: null,
        translateEffort: () => "Unexpected",
      }),
    ).toBe("GPT-5.6 Terra Default");
  });
});
