import { describe, expect, test } from "bun:test";

import { CanaryProviderRunError, errorSummary } from "./ai-provider-canary";

describe("AI provider canary error summaries", () => {
  test("reports only bounded provider codes and the failed tool stage", () => {
    const signal = new AbortController().signal;

    expect(
      errorSummary(
        new CanaryProviderRunError(
          { error: { code: "provider_error" } },
          "after-tool-result",
        ),
        signal,
      ),
    ).toBe("provider stream error after tool result (provider_error)");
  });

  test("does not include provider messages or unbounded code fields", () => {
    const signal = new AbortController().signal;
    const error = new CanaryProviderRunError(
      {
        code: "unsafe code containing request material",
        message: "provider response body",
      },
      "before-tool-call",
    );

    expect(errorSummary(error, signal)).toBe(
      "provider stream error before tool call",
    );
  });

  test("prefers a numeric provider status without exposing the event", () => {
    const signal = new AbortController().signal;
    const error = new CanaryProviderRunError(
      { rawEvent: { statusCode: 429, body: "not logged" } },
      "after-tool-call",
    );

    expect(errorSummary(error, signal)).toBe("provider HTTP 429");
  });
});
