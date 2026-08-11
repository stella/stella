import { describe, expect, test } from "bun:test";

import { toOutlookGenerationError } from "@/api/handlers/ai/outlook-generation-error";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

describe("toOutlookGenerationError", () => {
  test("preserves actionable handler errors", () => {
    const configurationError = new HandlerError({
      status: 403,
      message: "Configure the requested model role",
    });
    expect(
      toOutlookGenerationError(configurationError, "Generic failure"),
    ).toBe(configurationError);
  });

  test("wraps unknown provider failures", () => {
    const cause = new Error("provider unavailable");
    const error = toOutlookGenerationError(cause, "Generic failure");
    expect(error.status).toBe(502);
    expect(error.message).toBe("Generic failure");
    expect(error.cause).toBe(cause);
  });
});
