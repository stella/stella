import { describe, expect, test } from "bun:test";

import {
  failure,
  jsonSuccess,
  KIT_INTERNAL_MESSAGE,
  success,
  toCallResult,
} from "./envelope";
import type { McpJsonValue, ToolCallResult } from "./types";

const INTERNAL_RESULT = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        error: {
          code: "internal_error",
          message: KIT_INTERNAL_MESSAGE,
          retryable: false,
        },
      }),
    },
  ],
  isError: true,
} satisfies ToolCallResult;

describe("tool results preserve JSON data or return a safe error", () => {
  test("preserves primitive and nested JSON values and normalization notes", () => {
    for (const value of [
      null,
      true,
      42,
      "text",
      { nested: [false, null, { value: "text" }] },
    ]) {
      expect(
        toCallResult(success(value), ["Read input", "Read input"]),
      ).toEqual({
        content: [
          { type: "text", text: JSON.stringify(value) },
          { type: "text", text: "Input read: Read input" },
        ],
        isError: false,
      });
    }
  });

  test("permits shared references without mistaking them for cycles", () => {
    const shared = { value: "same" };
    const value = { first: shared, second: shared };
    expect(jsonSuccess(value)).toEqual(success(value));
    expect(toCallResult(success(value)).isError).toBe(false);
  });

  test("rejects unsupported values at the unknown DTO boundary", () => {
    const cyclic: { next?: unknown } = {};
    cyclic.next = cyclic;
    const withGetter = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => {
        throw new TypeError("private getter detail");
      },
    });
    const sparse: unknown[] = [];
    sparse.length = 1;
    const values: unknown[] = [
      undefined,
      1n,
      Symbol("private symbol"),
      () => null,
      Number.NaN,
      Infinity,
      -Infinity,
      cyclic,
      { value: undefined },
      { value: 1n },
      [undefined],
      sparse,
      { [Symbol("private key")]: "value" },
      { toJSON: () => "replacement" },
      new Date(0),
      withGetter,
    ];
    for (const value of values) {
      expect(toCallResult(jsonSuccess(value))).toEqual(INTERNAL_RESULT);
    }
  });

  test("reports cyclic typed payloads to the host and hides their cause", () => {
    const cyclic: { next: McpJsonValue } = { next: null };
    cyclic.next = cyclic;
    const causes: unknown[] = [];
    expect(
      toCallResult(success(cyclic), ["private note"], (cause) => {
        causes.push(cause);
      }),
    ).toEqual(INTERNAL_RESULT);
    expect(causes).toHaveLength(1);
    expect(causes.at(0)).toBeInstanceOf(Error);
  });

  test("guards unknown error details and ignores observer failures", () => {
    const cyclic: { next?: unknown } = {};
    cyclic.next = cyclic;
    for (const details of [cyclic, 1n, { value: undefined }, Infinity]) {
      const outcome = failure({
        code: "expected",
        message: "Original failure",
        details,
      });
      expect(
        toCallResult(outcome, [], () => {
          throw new TypeError("private observer detail");
        }),
      ).toEqual(INTERNAL_RESULT);
    }
  });

  test("serializes expected failures without success normalization notes", () => {
    const outcome = failure({
      code: "not_found",
      message: "Missing",
      details: { id: "item" },
    });
    expect(toCallResult(outcome, ["Read input"])).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "not_found",
              message: "Missing",
              retryable: false,
              details: { id: "item" },
            },
          }),
        },
      ],
      isError: true,
    });
  });
});
