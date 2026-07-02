import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  consumePartialAnswers,
  consumeTanStackPartialAnswer,
  formatPartialAnswer,
} from "@/api/lib/workflow/streaming-answer";

const propertyId = (value: string) => toSafeId<"property">(value);
type PartialAnswerUpdateFixture = {
  propertyId: ReturnType<typeof propertyId>;
  answer: string;
};

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

  test("does not over-truncate multibyte text below the character cap", () => {
    const answer = "🙂".repeat(300);
    expect(formatPartialAnswer(answer)).toBe(answer);
  });
});

describe("consumeTanStackPartialAnswer", () => {
  test("uses TanStack partial JSON parsing for streamed structured output", async () => {
    const updates: PartialAnswerUpdateFixture[] = [];

    await consumeTanStackPartialAnswer({
      propertyIds: [propertyId("p1")],
      rawJson: '{"p1":{"answer":"Alpha"',
      onPartialAnswer: (update) => {
        updates.push(update);
      },
    });

    expect(updates).toEqual([
      { propertyId: propertyId("p1"), answer: "Alpha" },
    ]);
  });
});

describe("consumePartialAnswers", () => {
  test("emits only answer text for known properties", async () => {
    const updates: PartialAnswerUpdateFixture[] = [];

    await consumePartialAnswers({
      propertyIds: [propertyId("p1"), propertyId("p2")],
      partialOutputs: [
        { p1: { answer: "Alpha", justification: "ignored" } },
        { p2: { answer: ["Beta", "Gamma"] }, p3: { answer: "ignored" } },
      ],
      onPartialAnswer: (update) => {
        updates.push(update);
      },
    });

    expect(updates).toEqual([
      { propertyId: propertyId("p1"), answer: "Alpha" },
      { propertyId: propertyId("p2"), answer: "Beta, Gamma" },
    ]);
  });
});
