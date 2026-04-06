import { describe, expect, test } from "bun:test";

import { InfoSoudAPIError } from "./errors.js";

describe("InfoSoudAPIError", () => {
  test("preserves ErrorOptions cause like the other exported error types", () => {
    const cause = new Error("upstream failed");
    const error = new InfoSoudAPIError({
      cause,
      message: "Bad request",
      path: "/rizeni/vyhledej",
      responseBody: { message: "invalid" },
      status: 400,
    });

    expect(error.cause).toBe(cause);
    expect(error.status).toBe(400);
    expect(error.path).toBe("/rizeni/vyhledej");
  });
});
