import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  VISUAL_PREVIEW_LIMITS,
  visualPreviewInputSchema,
  visualPreviewOutputSchema,
  visualPreviewToolOutputSchema,
} from "./visual-preview";

const output = {
  png: "iVBORw0KGgo=",
  consoleErrors: [],
  blockedRequests: 0,
  size: { width: 1200, height: 1 },
  readyFired: false,
};

describe("visual preview boundary", () => {
  test("accepts the document byte ceiling and measures UTF-8 bytes", () => {
    expect(
      v.safeParse(visualPreviewInputSchema, {
        document: "a".repeat(VISUAL_PREVIEW_LIMITS.documentBytes),
        viewport: { width: 1200 },
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(visualPreviewInputSchema, {
        document: "€".repeat(
          Math.ceil(VISUAL_PREVIEW_LIMITS.documentBytes / 3),
        ),
        viewport: { width: 1200 },
      }).success,
    ).toBe(false);
  });
  test.each([
    { document: "", viewport: { width: 1199 } },
    { document: "", viewport: { width: 1200, height: 200 } },
    { document: "", viewport: { width: 1200 }, extra: 1 },
  ])("rejects input outside the frozen contract", (input) => {
    expect(v.safeParse(visualPreviewInputSchema, input).success).toBe(false);
  });
  test("accepts boundary diagnostics and a missing ready signal", () => {
    expect(
      v.safeParse(visualPreviewOutputSchema, {
        ...output,
        consoleErrors: Array.from(
          { length: VISUAL_PREVIEW_LIMITS.consoleErrors },
          () => "x".repeat(VISUAL_PREVIEW_LIMITS.errorChars),
        ),
        size: { width: 1200, height: VISUAL_PREVIEW_LIMITS.height },
      }).success,
    ).toBe(true);
  });
  test.each([
    { ...output, png: "iVBORw0KGgo" },
    {
      ...output,
      png: `iVBORw0KGgo${"a".repeat(VISUAL_PREVIEW_LIMITS.pngBase64Chars)}`,
    },
    {
      ...output,
      consoleErrors: ["x".repeat(VISUAL_PREVIEW_LIMITS.errorChars + 1)],
    },
    { ...output, blockedRequests: 0.5 },
    { ...output, blockedRequests: Number.POSITIVE_INFINITY },
    { ...output, size: { width: 1200, height: 0 } },
    { ...output, size: { width: 1201, height: 1 } },
  ])("rejects malformed and unbounded diagnostics", (value) => {
    expect(v.safeParse(visualPreviewOutputSchema, value).success).toBe(false);
  });
});

describe("visual preview tool output boundary", () => {
  const text = { type: "text", content: "Example diagnostics" };
  const image = {
    type: "image",
    source: { type: "data", value: output.png, mimeType: "image/png" },
  };

  test.each([[text], [text, image]].map((parts) => ({ parts })))(
    "accepts one text part and optional PNG",
    ({ parts }) => {
      expect(v.safeParse(visualPreviewToolOutputSchema, parts).success).toBe(
        true,
      );
    },
  );

  test("accepts text at its ceiling", () => {
    expect(
      v.safeParse(visualPreviewToolOutputSchema, [
        { ...text, content: "x".repeat(VISUAL_PREVIEW_LIMITS.modelTextChars) },
      ]).success,
    ).toBe(true);
  });

  test.each(
    [
      [],
      [image],
      [image, text],
      [text, text],
      [text, image, image],
      [{ ...text, extra: true }],
      [
        {
          ...text,
          content: "x".repeat(VISUAL_PREVIEW_LIMITS.modelTextChars + 1),
        },
      ],
      [text, { ...image, source: { ...image.source, type: "url" } }],
      [text, { ...image, source: { ...image.source, mimeType: "image/jpeg" } }],
      [text, { ...image, source: { ...image.source, value: "not-png" } }],
      [text, { ...image, source: { ...image.source, extra: true } }],
      [
        text,
        {
          ...image,
          source: {
            ...image.source,
            value: `iVBORw0KGgo${"a".repeat(VISUAL_PREVIEW_LIMITS.pngBase64Chars)}`,
          },
        },
      ],
    ].map((parts) => ({ parts })),
  )("rejects unsupported, duplicate and unbounded parts", ({ parts }) => {
    expect(v.safeParse(visualPreviewToolOutputSchema, parts).success).toBe(
      false,
    );
  });
});

test.each(["", " \n\t"])(
  "rejects an empty preview document (%s)",
  (document) => {
    expect(
      v.safeParse(visualPreviewInputSchema, {
        document,
        viewport: { width: 1200 },
      }).success,
    ).toBe(false);
  },
);
