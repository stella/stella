import { describe, expect, test } from "bun:test";

import type { VisualGuestMessage } from "@stll/api-contract/visual-sandbox";

import { createVisualGuestApi } from "./guest-api";

describe("visual page runtime API", () => {
  test("exposes a frozen independent data tree before page interaction", () => {
    const row = { year: 2026 };
    const source = { courtYear: [row] };
    const api = createVisualGuestApi({
      data: source,
      postMessage: () => undefined,
      measureSize: () => ({ width: 1200, height: 400 }),
      takeGesture: () => false,
    });
    expect(Object.isFrozen(api)).toBe(true);
    expect(api.data).toEqual(source);
    expect(api.data).not.toBe(source);
    expect(Object.isFrozen(api.data)).toBe(true);
    expect(typeof api.data).toBe("object");
    if (
      typeof api.data !== "object" ||
      api.data === null ||
      !("courtYear" in api.data)
    ) {
      return;
    }
    expect(Array.isArray(api.data.courtYear)).toBe(true);
    if (!Array.isArray(api.data.courtYear)) {
      return;
    }
    expect(Object.isFrozen(api.data.courtYear)).toBe(true);
    expect(Object.isFrozen(api.data.courtYear.at(0))).toBe(true);
    row.year = 2025;
    expect(api.data).toEqual({ courtYear: [{ year: 2026 }] });
  });

  test("emits only bounded protocol messages from the page API", () => {
    const messages: VisualGuestMessage[] = [];
    const api = createVisualGuestApi({
      data: null,
      postMessage: (message) => {
        messages.push(message);
      },
      measureSize: () => ({ width: 1200, height: 400 }),
      takeGesture: () => true,
    });
    api.drill({ court: "court-one", year: 2026 });
    api.openDecision("decision-one");
    api.ready();
    expect(messages).toEqual([
      { kind: "drill", court: "court-one", year: 2026 },
      { kind: "open-internal", linkId: "decision-one" },
      { kind: "ready", size: { width: 1200, height: 400 } },
    ]);
    api.drill({ court: "", year: Number.NaN });
    api.openDecision("");
    expect(messages).toHaveLength(3);
  });

  test("sends sizing freely and one action per gesture token", () => {
    const messages: VisualGuestMessage[] = [];
    const tokens = { left: 0, taken: 0 };
    const api = createVisualGuestApi({
      data: null,
      postMessage: (message) => {
        messages.push(message);
      },
      measureSize: () => ({ width: 1200, height: 400 }),
      takeGesture: () => {
        tokens.taken += 1;
        if (tokens.left === 0) {
          return false;
        }
        tokens.left -= 1;
        return true;
      },
    });
    api.drill({ court: "court-one", year: 2026 });
    api.openDecision("decision-one");
    expect(messages).toEqual([]);
    api.ready();
    expect(messages).toEqual([
      { kind: "ready", size: { width: 1200, height: 400 } },
    ]);
    tokens.left = 1;
    api.drill({ court: "court-one", year: 2026 });
    api.openDecision("decision-one");
    api.drill({ court: "court-one", year: 2026 });
    expect(messages).toEqual([
      { kind: "ready", size: { width: 1200, height: 400 } },
      { kind: "drill", court: "court-one", year: 2026 },
    ]);
    // A message the protocol refuses does not spend a token.
    const taken = tokens.taken;
    tokens.left = 1;
    api.openDecision("");
    expect(tokens.taken).toBe(taken);
    api.openDecision("decision-one");
    expect(messages.at(-1)).toEqual({
      kind: "open-internal",
      linkId: "decision-one",
    });
  });
});
