import { describe, expect, test } from "bun:test";

import type { InternalToolError } from "@/api/mcp/tool-types";

import {
  classifyRegistryErrorKind,
  toRegistryChatToolError,
} from "./registry-tool-error";

describe("registry tool error projection", () => {
  test("preserves every structured recovery field at the chat boundary", () => {
    const error = {
      type: "structured",
      code: "validation_error",
      message: "The cursor is invalid.",
      hint: "Pass the cursor verbatim or omit it to restart pagination.",
      issues: [{ path: "cursor", message: "Invalid cursor" }],
      retryable: false,
      requestId: "request_123",
    } as const satisfies InternalToolError;

    const projected = toRegistryChatToolError(error);

    expect(projected.kind).toBe("invalid-input");
    expect(JSON.parse(projected.message)).toEqual({
      error: {
        code: "validation_error",
        message: "The cursor is invalid.",
        hint: "Pass the cursor verbatim or omit it to restart pagination.",
        issues: [{ path: "cursor", message: "Invalid cursor" }],
        retryable: false,
        requestId: "request_123",
      },
    });
  });

  test("keeps legacy text errors plain and conservatively correctable", () => {
    const error = {
      type: "text",
      message: "Use a supported argument combination.",
    } as const satisfies InternalToolError;

    expect(classifyRegistryErrorKind(error)).toBe("invalid-input");
    expect(toRegistryChatToolError(error)).toMatchObject({
      kind: "invalid-input",
      message: "Use a supported argument combination.",
    });
  });
});
