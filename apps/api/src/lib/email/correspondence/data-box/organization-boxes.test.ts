import { describe, expect, test } from "bun:test";

import { organizationDataBoxesChangeResult } from "./organization-boxes";

describe("organizationDataBoxesChangeResult", () => {
  test("a busy inventory lock answers a retryable unavailable error", () => {
    const result = organizationDataBoxesChangeResult({ type: "busy" });
    expect(result.isErr()).toBe(true);
    expect(result.isErr() ? result.error : null).toMatchObject({
      status: 503,
      code: "service_unavailable",
      retryable: true,
      retryAfterMs: 1000,
    });
  });

  test("a lost compare-and-swap answers a conflict to read again", () => {
    const result = organizationDataBoxesChangeResult({ type: "conflict" });
    expect(result.isErr() ? result.error : null).toMatchObject({
      status: 409,
    });
    expect(result.isErr() ? result.error.retryable : null).toBeUndefined();
  });

  test("a full inventory answers a client error", () => {
    const result = organizationDataBoxesChangeResult({ type: "limit_reached" });
    expect(result.isErr() ? result.error : null).toMatchObject({
      status: 400,
    });
  });

  test("a saved inventory answers the stored IDs", () => {
    const result = organizationDataBoxesChangeResult({
      type: "saved",
      value: { boxIds: ["abc1234"] },
    });
    expect(result.isOk() ? result.value : null).toEqual({
      boxIds: ["abc1234"],
    });
  });
});
