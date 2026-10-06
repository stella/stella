import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  VISUAL_SANDBOX_LIMITS,
  visualGuestMessageSchema,
  visualLinkSchema,
  visualRenderMessageSchema,
} from "./visual-sandbox";

describe("visual frame messages", () => {
  test("accepts bounded render requests", () => {
    expect(
      v.parse(visualRenderMessageSchema, {
        type: "render",
        title: " Timeline ",
        html: "<p>Dates</p>",
      }),
    ).toEqual({ type: "render", title: "Timeline", html: "<p>Dates</p>" });
    expect(
      v.safeParse(visualRenderMessageSchema, {
        type: "render",
        title: "Timeline",
        html: "x".repeat(VISUAL_SANDBOX_LIMITS.htmlBytes + 1),
      }).success,
    ).toBe(false);
  });

  test("accepts only the two documented guest message shapes", () => {
    expect(
      v.safeParse(visualGuestMessageSchema, { type: "resize", height: 300 })
        .success,
    ).toBe(true);
    expect(
      v.safeParse(visualGuestMessageSchema, {
        type: "open-link",
        url: "https://example.test/decision",
      }).success,
    ).toBe(true);
    for (const value of [
      { type: "resize", height: 0 },
      { type: "resize", height: 1.5 },
      { type: "resize", height: VISUAL_SANDBOX_LIMITS.height + 1 },
      { type: "resize", height: 300, title: "Timeline" },
      { type: "open-link", url: "/decision" },
      { type: "ready" },
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
