import { describe, expect, test } from "bun:test";

import {
  groupReasoningEfforts,
  modelSelectionLabel,
} from "@stll/chat/model-selector";

describe("modelSelectionLabel", () => {
  test("shows a compact friendly model name and thinking level", () => {
    expect(
      modelSelectionLabel({
        defaultEffortLabel: "Default",
        displayName: "Claude Opus 5",
        formatSelectionLabel: ({ effort, model }) => `${model} | ${effort}`,
        providerDefaultEffort: "high",
        reasoningEffort: "low",
        translateEffort: (effort) => (effort === "low" ? "Low" : "Unexpected"),
      }),
    ).toBe("Opus 5 | Low");
  });

  test("shows the concrete provider default when it is published", () => {
    expect(
      modelSelectionLabel({
        defaultEffortLabel: "Default",
        displayName: "Claude Opus 5",
        formatSelectionLabel: ({ effort, model }) => `${model} | ${effort}`,
        providerDefaultEffort: "high",
        reasoningEffort: null,
        translateEffort: (effort) =>
          effort === "high" ? "High" : "Unexpected",
      }),
    ).toBe("Opus 5 | High");
  });

  test("keeps Default when the provider publishes no named effort", () => {
    expect(
      modelSelectionLabel({
        defaultEffortLabel: "Default",
        displayName: "GPT-5.6",
        formatSelectionLabel: ({ effort, model }) => `${model} | ${effort}`,
        providerDefaultEffort: null,
        reasoningEffort: null,
        translateEffort: () => "Unexpected",
      }),
    ).toBe("GPT-5.6 | Default");
  });
});

describe("groupReasoningEfforts", () => {
  test("places every effort above High in a separate section", () => {
    expect(
      groupReasoningEfforts([
        "none",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    ).toEqual({
      standard: ["none", "minimal", "low", "medium", "high"],
      extended: ["xhigh", "max"],
    });
  });

  test("preserves provider order when an extended tier is absent", () => {
    expect(groupReasoningEfforts(["low", "medium", "high", "max"])).toEqual({
      standard: ["low", "medium", "high"],
      extended: ["max"],
    });
  });
});
