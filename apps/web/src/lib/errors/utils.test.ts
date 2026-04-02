import { describe, expect, test } from "bun:test";

import { ClientUnknownError } from "@/lib/errors";

import { transformUnknownError } from "./utils";

describe("transformUnknownError", () => {
  test("passes through Error instances unchanged", () => {
    const error = new Error("boom");

    expect(transformUnknownError(error)).toBe(error);
  });

  test("wraps nullish values in ClientUnknownError", () => {
    const result = transformUnknownError(null);

    expect(ClientUnknownError.is(result)).toBe(true);
    expect(result.message).toBe("Unknown error (null or undefined)");
  });

  test("stringifies plain objects", () => {
    const result = transformUnknownError({ reason: "broken", code: 42 });

    expect(ClientUnknownError.is(result)).toBe(true);
    expect(result.message).toBe('{"reason":"broken","code":42}');
  });

  test("uses the raw string for string inputs", () => {
    const result = transformUnknownError("nope");

    expect(ClientUnknownError.is(result)).toBe(true);
    expect(result.message).toBe("nope");
  });

  test("stringifies non-string primitives", () => {
    const result = transformUnknownError(false);

    expect(ClientUnknownError.is(result)).toBe(true);
    expect(result.message).toBe("false");
  });
});
