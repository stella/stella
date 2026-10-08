import { describe, expect, test } from "bun:test";

import {
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
});
