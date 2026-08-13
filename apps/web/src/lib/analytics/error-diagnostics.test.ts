import { describe, expect, test } from "bun:test";

import { telemetryErrorType } from "./error-diagnostics";
import { fingerprintTelemetryError } from "./error-fingerprint";

const errorWithStack = (message: string, stack: string) => {
  const error = new TypeError(message);
  error.stack = stack;
  return error;
};

describe("browser error diagnostics", () => {
  test("emits the analytics fingerprint format", () => {
    const error = errorWithStack(
      "redacted",
      "at https://staging.stll.app/assets/case-viewer-A1b2.js:42:7",
    );

    expect(fingerprintTelemetryError(error)).toMatch(/^ERRFP-[0-9A-F]{8}$/u);
  });

  test("fingerprints a compiled asset frame without using the message", () => {
    const first = errorWithStack(
      "Client Smith privileged decision",
      "TypeError: private\n at render (https://staging.stll.app/assets/case-viewer-A1b2.js:42:7)",
    );
    const second = errorWithStack(
      "Different privileged decision",
      "TypeError: other\n at render (https://staging.stll.app/assets/case-viewer-A1b2.js:42:7)",
    );

    expect(fingerprintTelemetryError(first)).toBe(
      fingerprintTelemetryError(second),
    );
  });

  test("distinguishes compiled asset positions", () => {
    const first = errorWithStack(
      "redacted",
      "at https://staging.stll.app/assets/case-viewer-A1b2.js:42:7",
    );
    const second = errorWithStack(
      "redacted",
      "at https://staging.stll.app/assets/case-viewer-A1b2.js:43:7",
    );

    expect(fingerprintTelemetryError(first)).not.toBe(
      fingerprintTelemetryError(second),
    );
  });

  test("ignores private non-asset paths and normalizes custom names", () => {
    const first = errorWithStack(
      "redacted",
      "at https://staging.stll.app/workspaces/private-matter/Client-Smith:42:7",
    );
    first.name = "Client Smith privileged dispute";
    const second = errorWithStack(
      "redacted",
      "at https://staging.stll.app/workspaces/another-matter/Other-Client:1:2",
    );
    second.name = "Other Client secret";

    expect(telemetryErrorType(first)).toBe("UnknownError");
    expect(fingerprintTelemetryError(first)).toBe(
      fingerprintTelemetryError(second),
    );
  });
});
