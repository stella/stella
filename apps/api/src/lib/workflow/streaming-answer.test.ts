import { describe, expect, test } from "bun:test";

import {
  consumePartialAnswers,
  formatPartialAnswer,
} from "@/api/lib/workflow/streaming-answer";

describe("formatPartialAnswer", () => {
  test("formats plain text answers", () => {
    expect(formatPartialAnswer("  Governing law is New York. ")).toBe(
      "Governing law is New York.",
    );
  });

  test("formats multi-select answers as comma-separated text", () => {
    expect(formatPartialAnswer(["Signed", "", "  Counterparty "])).toBe(
      "Signed, Counterparty",
    );
  });

  test("formats numeric currency answers", () => {
    expect(formatPartialAnswer({ amount: 1500, currency: "EUR" })).toBe(
      "1500 EUR",
    );
    expect(formatPartialAnswer({ amount: 1500, currency: null })).toBe("1500");
  });

  test("drops empty and incomplete answers", () => {
    expect(formatPartialAnswer(" ")).toBeNull();
    expect(formatPartialAnswer([])).toBeNull();
    expect(formatPartialAnswer({ currency: "EUR" })).toBeNull();
  });

  test("caps long streamed text before publishing it", () => {
    expect(formatPartialAnswer("x".repeat(600))).toHaveLength(500);
  });
});

describe("consumePartialAnswers", () => {
  test("emits only answer text for known properties", async () => {
    const updates: { propertyId: string; answer: string }[] = [];

    await consumePartialAnswers({
      propertyIds: ["p1", "p2"],
      partialOutputs: [
        { p1: { answer: "Alpha", justification: "ignored" } },
        { p2: { answer: ["Beta", "Gamma"] }, p3: { answer: "ignored" } },
      ],
      onPartialAnswer: (update) => {
        updates.push(update);
      },
    });

    expect(updates).toEqual([
      { propertyId: "p1", answer: "Alpha" },
      { propertyId: "p2", answer: "Beta, Gamma" },
    ]);
  });
});
