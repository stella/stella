import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  ACTION_ADMISSION_CODES,
  ACTION_ADMISSION_REFUSALS,
  isActionAdmissionCode,
} from "@stll/api-contract/action-admission";

import { PLAYBOOK_RUN_FAILURE_CODE } from "@/api/lib/document-review/playbook-run-refusal";
import type { ChatToolErrorKind } from "@/api/lib/errors/tagged-errors";
import type { InternalToolError } from "@/api/mcp/tool-types";

import {
  classifyRegistryErrorKind,
  toRegistryChatToolError,
} from "./registry-tool-error";

describe("registry tool error projection", () => {
  test("preserves admission recovery fields when projecting to chat", () => {
    for (const [code, metadata] of Object.entries(ACTION_ADMISSION_REFUSALS)) {
      if (!isActionAdmissionCode(code)) {
        panic("Unknown action admission code");
      }
      const error = {
        type: "structured",
        code,
        message: metadata.message,
        hint: metadata.hint,
        retryable: metadata.retryable,
        contactUrl: "https://example.test/contact",
      } as const satisfies InternalToolError;
      const projected = toRegistryChatToolError(error);
      const permanentKind =
        code === ACTION_ADMISSION_CODES.periodExhausted
          ? "limit"
          : "unavailable";
      expect(projected.kind).toBe(
        metadata.retryable ? "transient" : permanentKind,
      );
      expect(JSON.parse(projected.message)).toEqual({
        error: {
          code,
          message: metadata.message,
          hint: metadata.hint,
          retryable: metadata.retryable,
          contactUrl: error.contactUrl,
        },
      });
    }
  });
  test("preserves playbook refusal codes and recovery fields through chat", () => {
    const expectedKinds = {
      properties_limit_reached: "limit",
      playbook_scope_unresolved: "invalid-input",
      file_property_type_immutable: "invalid-input",
    } as const satisfies Record<
      (typeof PLAYBOOK_RUN_FAILURE_CODE)[keyof typeof PLAYBOOK_RUN_FAILURE_CODE],
      ChatToolErrorKind
    >;
    for (const code of Object.values(PLAYBOOK_RUN_FAILURE_CODE)) {
      const details = {
        code,
        message: "The playbook cannot run.",
        hint: "Correct the matter configuration before running it.",
        retryable: false,
      };
      const projected = toRegistryChatToolError({
        type: "structured",
        ...details,
      });
      expect(projected.kind).toBe(expectedKinds[code]);
      expect(JSON.parse(projected.message)).toEqual({ error: details });
    }
  });

  test("keeps oversized read results recoverable through a smaller request", () => {
    const error = {
      type: "structured",
      code: "result_too_large",
      message: "The result is too large.",
      hint: "Request a smaller page.",
    } as const satisfies InternalToolError;

    expect(toRegistryChatToolError(error)).toMatchObject({
      kind: "invalid-input",
      message: JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          hint: error.hint,
        },
      }),
    });
  });

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
