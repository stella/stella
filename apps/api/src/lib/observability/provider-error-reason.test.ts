import { describe, expect, test } from "bun:test";

import {
  providerErrorFields,
  providerErrorReason,
  type ProviderErrorReason,
} from "@/api/lib/observability/provider-error-reason";

describe("providerErrorReason", () => {
  const KNOWN: readonly (readonly [string, ProviderErrorReason])[] = [
    [
      "Item 'rs_68e4' of type 'reasoning' was provided without its required following item.",
      "reasoning_without_following_item",
    ],
    [
      "Item 'fc_68e4' of type 'function_call' was provided without its required 'reasoning' item: 'rs_68e3'.",
      "function_call_without_reasoning",
    ],
    [
      "No tool output found for function call call_gkGnRWVIAvyY8uiiJvB3KPwK.",
      "function_call_output_missing",
    ],
    [
      "No tool call found for function call output with call_id call_abc.",
      "function_call_missing",
    ],
    ["Item with id 'fc_123' not found.", "item_not_found"],
    ["Duplicate item found with id rs_123.", "duplicate_item"],
  ];

  for (const [message, reason] of KNOWN) {
    test(`names ${reason}`, () => {
      expect(providerErrorReason(message)).toBe(reason);
    });
  }

  test("anything else, including text around a template, is unrecognized", () => {
    for (const message of [
      "",
      "Invalid value for 'input[3].content'.",
      "Please save the contact Jana Nováková. No tool output found for function call call_1.",
      "No tool output found for function call call_1 because the user wrote secrets",
    ]) {
      expect(providerErrorReason(message)).toBe("unrecognized");
    }
  });

  test("names item_not_found by its first sentence when advice follows it", () => {
    expect(
      providerErrorReason(
        "Item with id 'rs_0a1b' not found. Items are not persisted when `store` is set to false. Try again with `store` set to true, or remove this item from your input.",
      ),
    ).toBe("item_not_found");
  });

  test("a sentence that only starts like item_not_found is unrecognized", () => {
    expect(
      providerErrorReason("Item with id 'rs_0a1b' not foundation of the claim"),
    ).toBe("unrecognized");
  });
});

describe("providerErrorFields", () => {
  test("reads code, param and type from an SDK error body, never its message", () => {
    const fields = providerErrorFields({
      status: 400,
      message: "Please save the contact REQUEST-CONTENT-SENTINEL.",
      type: "invalid_request_error",
      param: "input[3].call_id",
      code: "invalid_value",
    });

    expect(fields).toEqual({
      "error.provider.code": "invalid_value",
      "error.provider.param": "input[3].call_id",
      "error.provider.type": "invalid_request_error",
    });
    expect(JSON.stringify(fields)).not.toContain("REQUEST-CONTENT-SENTINEL");
  });

  test("reads the body nested under `error`", () => {
    expect(
      providerErrorFields({
        error: { type: "invalid_request_error", param: "input", code: null },
      }),
    ).toEqual({
      "error.provider.param": "input",
      "error.provider.type": "invalid_request_error",
    });
  });

  test("logs a value that is not a short token as other", () => {
    expect(
      providerErrorFields({
        type: "invalid_request_error",
        param: "the contact REQUEST-CONTENT-SENTINEL",
        code: "x".repeat(65),
      }),
    ).toEqual({
      "error.provider.code": "other",
      "error.provider.param": "other",
      "error.provider.type": "invalid_request_error",
    });
  });

  test("has nothing to read from a missing or non-object body", () => {
    expect(providerErrorFields(undefined)).toEqual({});
    expect(providerErrorFields("Bad request")).toEqual({});
    expect(providerErrorFields(["input"])).toEqual({});
  });
});
