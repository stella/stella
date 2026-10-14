import { expect, test } from "bun:test";

import { createSsrErrorReporter } from "./ssr-error-reporter";

test("SSR diagnostics precede analytics and survive analytics failures", () => {
  const diagnostics: string[] = [];
  const captured: unknown[] = [];
  const renderFailure = new TypeError("Sensitive renderer message");
  const analyticsFailure = new RangeError("Sensitive telemetry message");
  const report = createSsrErrorReporter({
    writeDiagnostic: (line) => {
      diagnostics.push(line);
    },
    captureError: (error) => {
      expect(diagnostics).toHaveLength(1);
      captured.push(error);
      throw analyticsFailure;
    },
  });
  report(renderFailure);
  expect(captured).toEqual([renderFailure]);
  expect(diagnostics.map((line) => JSON.parse(line))).toEqual([
    { severity: "ERROR", message: "ssr.response_failed", error: "TypeError" },
    { severity: "ERROR", message: "ssr.telemetry_failed", error: "RangeError" },
  ]);
  expect(diagnostics.join("")).not.toContain("Sensitive");
});
