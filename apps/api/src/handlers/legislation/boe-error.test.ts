import { describe, expect, it } from "bun:test";
import fc from "fast-check";

import {
  BoeAPIError,
  BoeNotFoundError,
  BoeRequestError,
  BoeValidationError,
} from "@stll/boe";
import { assertProperty } from "@stll/property-testing";

import { mapBoeError } from "@/api/handlers/legislation/boe-error";

describe("mapBoeError", () => {
  it("BOE 5xx failures preserve their status as retryable upstream evidence", () => {
    assertProperty(
      "BOE 5xx failures preserve their status as retryable upstream evidence",
      fc.property(fc.integer({ min: 500, max: 599 }), (httpStatus) => {
        const cause = new BoeAPIError({ message: "Unavailable", httpStatus });
        const mapped = mapBoeError(cause);
        expect(mapped.status).toBe(502);
        expect(mapped.code).toBe("upstream_unavailable");
        expect(mapped.cause).toBe(cause);
        expect(cause.httpStatus).toBe(httpStatus);
      }),
    );
  });

  it("BOE 4xx failures ask the caller to correct the request", () => {
    assertProperty(
      "BOE 4xx failures ask the caller to correct the request",
      fc.property(fc.integer({ min: 400, max: 499 }), (httpStatus) => {
        const cause = new BoeAPIError({ message: "Rejected", httpStatus });
        const mapped = mapBoeError(cause);
        expect(mapped.status).toBe(400);
        expect(mapped.code).toBeUndefined();
        expect(mapped.message).toContain("Check the identifier and filters");
        expect(mapped.cause).toBe(cause);
        expect(cause.httpStatus).toBe(httpStatus);
      }),
    );
  });

  it("an invalid successful response remains an internal failure", () => {
    const cause = new BoeAPIError({
      message: "Invalid shape",
      httpStatus: 200,
    });
    const mapped = mapBoeError(cause);
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBeUndefined();
    expect(mapped.cause).toBe(cause);
  });

  it("tags an incomplete request as upstream_unavailable", () => {
    const cause = new BoeRequestError("https://example.test", "timed out");
    const mapped = mapBoeError(cause);
    expect(mapped.status).toBe(502);
    expect(mapped.code).toBe("upstream_unavailable");
    expect(mapped.cause).toBe(cause);
  });

  it("keeps caller errors untagged", () => {
    expect(mapBoeError(new BoeValidationError("bad id")).status).toBe(400);
    expect(mapBoeError(new BoeNotFoundError("X")).status).toBe(404);
    expect(mapBoeError(new BoeValidationError("bad id")).code).toBeUndefined();
  });

  it("leaves unknown errors as internal failures", () => {
    const mapped = mapBoeError(new Error("boom"));
    expect(mapped.status).toBe(500);
    expect(mapped.code).toBeUndefined();
  });
});
