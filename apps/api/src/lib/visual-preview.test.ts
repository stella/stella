import { normalizeToolResult } from "@tanstack/ai";
import type { ContentPart } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  VISUAL_PREVIEW_LIMITS,
  visualPreviewToolOutputSchema,
  type VisualPreviewOutput,
} from "@stll/api-contract/visual-preview";
import { VISUAL_SANDBOX_LIMITS } from "@stll/api-contract/visual-sandbox";

import {
  previewVisual,
  visualPreviewFailureModelContent,
  visualPreviewModelContent,
} from "./visual-preview";

const output = {
  png: "iVBORw0KGgo=",
  consoleErrors: ["Example diagnostic"],
  blockedRequests: 2,
  size: { width: 1200, height: 200 },
  readyFired: true,
} satisfies VisualPreviewOutput;
const payload = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const functionArn = "preview-test-function";

test("projects preview as a model image with bounded text diagnostics", () => {
  const content = visualPreviewModelContent({
    title: "Example",
    preview: output,
  }) satisfies ContentPart[];
  expect(v.safeParse(visualPreviewToolOutputSchema, content).success).toBe(
    true,
  );
  expect(normalizeToolResult(content)).toBe(content);
  expect(content).toEqual([
    {
      type: "text",
      content: JSON.stringify({
        success: true,
        title: "Example",
        preview: {
          consoleErrors: output.consoleErrors,
          blockedRequests: output.blockedRequests,
          size: output.size,
          readyFired: output.readyFired,
        },
      }),
    },
    {
      type: "image",
      source: { type: "data", value: output.png, mimeType: "image/png" },
    },
  ]);
});

test("projects unavailable preview as text while preserving publishing success", async () => {
  const result = await previewVisual({ document: "", functionArn: undefined });
  expect(Result.isError(result)).toBe(true);
  if (!Result.isError(result)) {
    return;
  }
  const content = visualPreviewFailureModelContent({
    title: "Example",
    error: result.error,
  }) satisfies ContentPart[];
  expect(v.safeParse(visualPreviewToolOutputSchema, content).success).toBe(
    true,
  );
  expect(normalizeToolResult(content)).toBe(content);
  expect(content).toHaveLength(1);
  expect(JSON.parse(content[0].content)).toEqual({
    success: true,
    title: "Example",
    preview: {
      status: "unavailable",
      reason: "unavailable",
      message: result.error.message,
    },
  });
});

test("accepts maximum escaped diagnostics in the model text budget", () => {
  const content = visualPreviewModelContent({
    title: "\u0000".repeat(VISUAL_SANDBOX_LIMITS.titleChars),
    preview: {
      ...output,
      consoleErrors: Array.from(
        { length: VISUAL_PREVIEW_LIMITS.consoleErrors },
        () => "\u0000".repeat(VISUAL_PREVIEW_LIMITS.errorChars),
      ),
    },
  });
  expect(v.safeParse(visualPreviewToolOutputSchema, content).success).toBe(
    true,
  );
});

describe("visual preview invocation", () => {
  test("decodes a Uint8Array Lambda payload and validates the shared output", async () => {
    const result = await previewVisual({
      document: "<html></html>",
      functionArn,
      invoke: async ({ input }) => {
        expect(input.viewport.width).toBe(1200);
        expect(input.document).toBe("<html></html>");
        const bytes = payload(output);
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(bytes)).toBe(false);
        return { payload: bytes };
      },
    });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value).toEqual(output);
    }
  });
  test("reports absent configuration without invoking", async () => {
    const result = await previewVisual({
      document: "",
      functionArn: undefined,
      invoke: async () => {
        throw new Error("Invocation should not happen");
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("unavailable");
    }
  });
  test("aborts on deadline even when the transport does not settle", async () => {
    let signal: AbortSignal | undefined;
    const result = await previewVisual({
      document: "",
      functionArn,
      timeoutMs: 5,
      invoke: async ({ signal: invocationSignal }) => {
        signal = invocationSignal;
        return new Promise(() => {});
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("timeout");
    }
    expect(signal?.aborted).toBe(true);
  });
  test.each([{ functionError: "Unhandled", payload: payload(output) }, {}])(
    "grades unsuccessful Lambda invocations as unavailable",
    async (reply) => {
      const result = await previewVisual({
        document: "",
        functionArn,
        invoke: async () => reply,
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error.code).toBe("unavailable");
      }
    },
  );
  test.each([
    payload({ ...output, blockedRequests: -1 }),
    payload({ ...output, size: { width: 1200, height: 2401 } }),
    payload({ ...output, readyFired: "true" }),
    payload({
      ...output,
      consoleErrors: Array.from({ length: 21 }, () => "error"),
    }),
    payload({ ...output, png: "not a png" }),
    payload({ ...output, extra: true }),
    new Uint8Array(2 * 1024 * 1024),
    new TextEncoder().encode("{invalid"),
    new Uint8Array([255]),
  ])("rejects replies outside the shared contract", async (reply) => {
    const result = await previewVisual({
      document: "",
      functionArn,
      invoke: async () => ({ payload: reply }),
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("invalid-response");
    }
  });
  test("rejects oversized UTF-8 input before invocation", async () => {
    const result = await previewVisual({
      document: "€".repeat(800_000),
      functionArn,
      invoke: async () => {
        throw new Error("Invocation should not happen");
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("invalid-input");
    }
  });
  test("propagates transport failure without including payload or cause", async () => {
    const result = await previewVisual({
      document: "",
      functionArn,
      invoke: async () => {
        throw new Error("Private content");
      },
    });
    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error.code).toBe("unavailable");
      expect(JSON.stringify(result.error)).not.toContain("Private content");
    }
  });
});
