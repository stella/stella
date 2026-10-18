import { describe, expect, test } from "bun:test";

import type { Analytics } from "@/lib/analytics/types";
import { APIError, toAPIError } from "@/lib/errors/api";

const recorded: unknown[] = [];
const captureError: Analytics["captureError"] = (error) => {
  recorded.push(error);
};

describe("captureError contract", () => {
  test("rejects a raw Eden error envelope at compile time", () => {
    const envelope = { status: 500, value: { message: "boom" } };
    // @ts-expect-error a raw envelope drops the API status and code; pass toAPIError(envelope)
    captureError(envelope);
    const captureMaybe = (maybe: typeof envelope | null) => {
      // @ts-expect-error a nullable envelope is still an envelope
      captureError(maybe);
    };
    captureMaybe(null);
    captureError(toAPIError(envelope));

    expect(recorded.at(-1)).toBeInstanceOf(APIError);
  });

  test("accepts catch-clause unknowns and errors", () => {
    const caught: unknown = new Error("caught");
    captureError(caught);
    captureError(new Error("plain"));
    captureError(new APIError({ status: 404, message: "missing" }));

    expect(recorded.slice(-3)).toHaveLength(3);
  });
});
