import { Panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "./rejection.ts";

describe("rejectionOf", () => {
  test("returns the reason a promise rejects with", async () => {
    const reason = new RangeError("out of range");
    expect(await rejectionOf(Promise.reject(reason))).toBe(reason);
  });

  test("returns a non-Error reason unchanged", async () => {
    // oxlint-disable-next-line prefer-promise-reject-errors -- a non-Error reason is the case under test
    expect(await rejectionOf(Promise.reject("plain"))).toBe("plain");
  });

  test("rejects with a Panic when the promise resolves", async () => {
    const outcome = await rejectionOf(Promise.resolve(42)).then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(Panic);
  });
});
