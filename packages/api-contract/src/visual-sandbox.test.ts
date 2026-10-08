import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { visualRenderMessageSchema } from "./generated-visual";
import {
  VISUAL_SANDBOX_LIMITS,
  visualGuestMessageSchema,
  type VisualGuestMessage,
  visualLinkSchema,
} from "./visual-sandbox";

describe("visual frame messages", () => {
  test("accepts bounded render requests", () => {
    expect(
      v.parse(visualRenderMessageSchema, {
        type: "render",
        data: {},
        title: " Timeline ",
        html: "<p>Dates</p>",
      }),
    ).toEqual({
      data: {},
      type: "render",
      title: " Timeline ",
      html: "<p>Dates</p>",
    });
    expect(
      v.safeParse(visualRenderMessageSchema, {
        type: "render",
        data: {},
        title: "Timeline",
        html: "x".repeat(VISUAL_SANDBOX_LIMITS.htmlBytes + 1),
      }).success,
    ).toBe(false);
  });

  test("accepts exactly the documented guest message kinds", () => {
    const messages = {
      resize: { kind: "resize", height: 300 },
      ready: { kind: "ready", size: { width: 1200, height: 400 } },
      "open-link": { kind: "open-link", url: "https://example.test/decision" },
      "open-internal": { kind: "open-internal", linkId: "decision-one" },
      drill: { kind: "drill", court: "court-one", year: 2026 },
    } as const satisfies Record<VisualGuestMessage["kind"], VisualGuestMessage>;
    for (const message of Object.values(messages)) {
      expect(v.safeParse(visualGuestMessageSchema, message).success).toBe(true);
    }
    for (const value of [
      { kind: "resize", height: 0 },
      { kind: "resize", height: 1.5 },
      { kind: "resize", height: VISUAL_SANDBOX_LIMITS.height + 1 },
      { kind: "resize", height: 300, title: "Timeline" },
      { kind: "open-link", url: "/decision" },
      { type: "ready" },
      { kind: "ready", size: { width: 0, height: 400 } },
      { kind: "ready", size: { width: 1200, height: 400, extra: true } },
      { kind: "drill", court: "court-one", year: 2026.5 },
      { kind: "drill", court: "", year: 2026 },
      { kind: "open-internal", linkId: "" },
    ]) {
      expect(v.safeParse(visualGuestMessageSchema, value).success).toBe(false);
    }
  });

  test("links are absolute HTTP URLs with no embedded credentials", () => {
    for (const url of [
      "https://example.test/path?q=1#section",
      "http://example.test/path",
    ]) {
      expect(v.safeParse(visualLinkSchema, url).success).toBe(true);
    }
    for (const url of [
      "https://user:password@example.test",
      "file:///document",
      "mailto:reader@example.test",
    ]) {
      expect(v.safeParse(visualLinkSchema, url).success).toBe(false);
    }
  });
});
