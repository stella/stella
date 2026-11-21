import { describe, expect, test } from "bun:test";

import { parseVisualOuterConfig, whenVisualDocumentReady } from "./boot";

describe("visual frame boot", () => {
  test("returns typed errors for malformed configurations", () => {
    for (const text of ["{", "null", '{"origins":[],"policy":42}']) {
      const parsed = parseVisualOuterConfig(text);
      expect(parsed.isErr()).toBe(true);
      if (parsed.isErr()) {
        expect(parsed.error._tag).toBe("VisualBootError");
      }
    }
    expect(
      parseVisualOuterConfig(
        '{"origins":[],"policy":"default-src none"}',
      ).isOk(),
    ).toBe(true);
  });

  test("starts immediately for interactive and complete documents", () => {
    for (const readyState of ["interactive", "complete"] as const) {
      let starts = 0;
      const target = new EventTarget();
      whenVisualDocumentReady(
        {
          readyState,
          addEventListener: target.addEventListener.bind(target),
        },
        () => {
          starts += 1;
        },
      );
      expect(starts).toBe(1);
      target.dispatchEvent(new Event("DOMContentLoaded"));
      expect(starts).toBe(1);
    }
  });

  test("starts once after a loading document becomes ready", () => {
    let starts = 0;
    const target = new EventTarget();
    whenVisualDocumentReady(
      {
        readyState: "loading",
        addEventListener: target.addEventListener.bind(target),
      },
      () => {
        starts += 1;
      },
    );
    expect(starts).toBe(0);
    target.dispatchEvent(new Event("DOMContentLoaded"));
    target.dispatchEvent(new Event("DOMContentLoaded"));
    expect(starts).toBe(1);
  });
});
