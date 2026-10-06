import { describe, expect, test } from "bun:test";

import { toSafeId } from "@stll/api-contract/safe-id";
import { createVisualActionGate } from "@stll/api-contract/visual-bridge-policy";
import type { VisualGuestMessage } from "@stll/api-contract/visual-sandbox";

import {
  activateVisual,
  parseVisualHostMessage,
} from "./generated-visual.logic";

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
          interaction: { status: "interactive", activatedFrame: frameWindow },
          actionGate: gate(),
        }),
      ).toEqual(expect.objectContaining(data));
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
            interaction: { status: "interactive", activatedFrame: frameWindow },
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
            interaction: { status: "interactive", activatedFrame: frameWindow },
            actionGate: gate(),
          }),
        ).toBeNull();
      }
      expect(
        parseVisualHostMessage({
          event,
          frameWindow,
          outerOrigin,
          interaction: { status: "interactive", activatedFrame: frameWindow },
          actionGate: null,
        }),
      ).toBeNull();
    }
  });
  test("drops actions before parent activation without consuming their rate limit", () => {
    const actionGate = gate();
    const actions = [
      { kind: "drill", court: "court-one", year: 2026 },
      { kind: "open-internal", linkId: "decision-one" },
      { kind: "open-link", url: "https://example.test/decision?language=cs" },
    ];
    for (const data of actions) {
      const options = {
        event: { source: frameWindow, origin: outerOrigin, data },
        frameWindow,
        outerOrigin,
        actionGate,
      };
      expect(
        parseVisualHostMessage({
          ...options,
          interaction: { status: "preview" },
        }),
      ).toBeNull();
      expect(
        parseVisualHostMessage({
          ...options,
          interaction: { status: "interactive", activatedFrame: {} },
        }),
      ).toBeNull();
      expect(
        parseVisualHostMessage({
          ...options,
          interaction: { status: "interactive", activatedFrame: frameWindow },
        }),
      ).toEqual(expect.objectContaining(data));
    }
    for (const data of [
      { kind: "resize", height: 320 },
      { kind: "ready", size: { width: 1200, height: 320 } },
    ]) {
      expect(
        parseVisualHostMessage({
          event: { source: frameWindow, origin: outerOrigin, data },
          frameWindow,
          outerOrigin,
          actionGate,
          interaction: { status: "preview" },
        }),
      ).toEqual(expect.objectContaining(data));
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
          interaction: { status: "interactive", activatedFrame: frameWindow },
          actionGate: gate(),
        }),
      ).toBeNull();
    }
  });
});

describe("generated view activation", () => {
  test("waits for the frame's first load", () => {
    const loading = { status: "loading" } as const;
    expect(activateVisual(loading, frameWindow)).toBe(loading);
  });

  test("activates a loaded preview for the frame's current window", () => {
    expect(activateVisual({ status: "preview" }, frameWindow)).toEqual({
      status: "interactive",
      activatedFrame: frameWindow,
    });
  });

  test("needs a frame window", () => {
    const preview = { status: "preview" } as const;
    expect(activateVisual(preview, null)).toBe(preview);
    expect(activateVisual(preview, undefined)).toBe(preview);
  });

  test("keeps an active view bound to the window it activated", () => {
    const interactive = {
      status: "interactive",
      activatedFrame: frameWindow,
    } as const;
    expect(activateVisual(interactive, {})).toBe(interactive);
  });

  test("ignores guest actions while the frame is loading", () => {
    expect(
      parseVisualHostMessage({
        event: {
          source: frameWindow,
          origin: outerOrigin,
          data: { kind: "drill", court: "court-one", year: 2026 },
        },
        frameWindow,
        outerOrigin,
        interaction: { status: "loading" },
        actionGate: gate(),
      }),
    ).toBeNull();
  });
});
