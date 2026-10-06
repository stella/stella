import { describe, expect, test } from "bun:test";

import { toSafeId } from "@stll/api-contract/safe-id";
import { createVisualActionGate } from "@stll/api-contract/visual-bridge-policy";
import type { VisualGuestMessage } from "@stll/api-contract/visual-sandbox";

import { parseVisualHostMessage } from "./generated-visual.logic";

const outerOrigin = "null";
const frameWindow = {};
const gate = () =>
  createVisualActionGate({
    data: { courtYear: { buckets: [{ court: "court-one", year: 2026 }] } },
    links: [
      {
        id: "decision-one",
        decisionId: toSafeId<"caseLawDecision">("decision-id"),
      },
    ],
    literalLinks: ["https://example.test/decision?language=cs"],
    now: () => 1000,
  });

describe("generated view parent messages", () => {
  test("accepts each canonical kind only from the configured frame", () => {
    const messages = [
      { kind: "resize", height: 400 },
      { kind: "ready", size: { width: 1200, height: 400 } },
      { kind: "drill", court: "court-one", year: 2026 },
      { kind: "open-internal", linkId: "decision-one" },
      { kind: "open-link", url: "https://example.test/decision?language=cs" },
    ] as const satisfies readonly VisualGuestMessage[];
    for (const data of messages) {
      const event = { source: frameWindow, origin: outerOrigin, data };
      expect(
        parseVisualHostMessage({
          event,
          frameWindow,
          outerOrigin,
          actionGate: gate(),
        }),
      ).toEqual(data);
      for (const rejected of [
        { ...event, source: {} },
        { ...event, origin: "https://api.example.test" },
        { ...event, origin: "https://other.example.test" },
        { ...event, data: { ...data, extra: true } },
      ]) {
        expect(
          parseVisualHostMessage({
            event: rejected,
            frameWindow,
            outerOrigin,
            actionGate: gate(),
          }),
        ).toBeNull();
      }
      for (const missing of [null, undefined]) {
        expect(
          parseVisualHostMessage({
            event,
            frameWindow: missing,
            outerOrigin,
            actionGate: gate(),
          }),
        ).toBeNull();
      }
      expect(
        parseVisualHostMessage({
          event,
          frameWindow,
          outerOrigin,
          actionGate: null,
        }),
      ).toBeNull();
    }
  });
  test("requires stored link and drill targets before the UI sees an action", () => {
    for (const data of [
      { kind: "open-link", url: "https://example.test/decision?language=en" },
      { kind: "open-internal", linkId: "another-decision" },
      { kind: "drill", court: "court-one", year: 2025 },
    ]) {
      expect(
        parseVisualHostMessage({
          event: { source: frameWindow, origin: outerOrigin, data },
          frameWindow,
          outerOrigin,
          actionGate: gate(),
        }),
      ).toBeNull();
    }
  });
});
