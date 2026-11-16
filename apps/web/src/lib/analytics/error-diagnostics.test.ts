import { TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { API_ERROR_TAG } from "@/lib/errors/api-tag";

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

    expect(
      fingerprintTelemetryError(error, {
        key: "routeError:caught",
        scope: { type: "handler", handlerId: "routeError:caught" },
      }),
    ).toMatch(/^ERRFP-[0-9A-F]{8}$/u);
  });

  test("fingerprints its declared owner without using the message", () => {
    const first = errorWithStack(
      "Client Smith privileged decision",
      "TypeError: private\n at render (https://staging.stll.app/assets/case-viewer-A1b2.js:42:7)",
    );
    const second = errorWithStack(
      "Different privileged decision",
      "TypeError: other\n at render (https://staging.stll.app/assets/case-viewer-A1b2.js:42:7)",
    );

    expect(
      fingerprintTelemetryError(first, {
        key: "routeError:caught",
        scope: { type: "handler", handlerId: "routeError:caught" },
      }),
    ).toBe(
      fingerprintTelemetryError(second, {
        key: "routeError:caught",
        scope: { type: "handler", handlerId: "routeError:caught" },
      }),
    );
  });

  test("ignores compiled asset positions", () => {
    const first = errorWithStack(
      "redacted",
      "at https://staging.stll.app/assets/case-viewer-A1b2.js:42:7",
    );
    const second = errorWithStack(
      "redacted",
      "at https://staging.stll.app/assets/case-viewer-A1b2.js:43:7",
    );

    expect(
      fingerprintTelemetryError(first, {
        key: "routeError:caught",
        scope: { type: "handler", handlerId: "routeError:caught" },
      }),
    ).toBe(
      fingerprintTelemetryError(second, {
        key: "routeError:caught",
        scope: { type: "handler", handlerId: "routeError:caught" },
      }),
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
    expect(
      fingerprintTelemetryError(first, {
        key: "routeError:caught",
        scope: { type: "handler", handlerId: "routeError:caught" },
      }),
    ).toBe(
      fingerprintTelemetryError(second, {
        key: "routeError:caught",
        scope: { type: "handler", handlerId: "routeError:caught" },
      }),
    );
  });
});

class ClassifiedApiError extends TaggedError(API_ERROR_TAG)<{
  message: string;
  status: number;
  code: string;
}> {}

const CLIENT_ERROR_STATUS_MIN = 400;
const SERVER_ERROR_STATUS_MAX = 599;

test("compact route fingerprints retain HTTP outcome classifications through wrappers", () => {
  assertProperty(
    "compact route fingerprints retain HTTP outcome classifications through wrappers",
    fc.property(
      fc.integer({
        min: CLIENT_ERROR_STATUS_MIN,
        max: SERVER_ERROR_STATUS_MAX,
      }),
      fc.boolean(),
      (status, changeStatus) => {
        const fingerprint = (nextStatus: number, code: string) =>
          fingerprintTelemetryError(
            new Error("private wrapper", {
              cause: new ClassifiedApiError({
                message: "private response",
                status: nextStatus,
                code,
              }),
            }),
            {
              key: "routeError:caught",
              scope: {
                type: "request",
                method: "GET",
                routeTemplate: "/workspaces/$workspaceId",
              },
            },
          );
        const adjacentStatus =
          status === SERVER_ERROR_STATUS_MAX
            ? CLIENT_ERROR_STATUS_MIN
            : status + 1;
        expect(fingerprint(status, "resource_unavailable")).not.toBe(
          fingerprint(
            changeStatus ? adjacentStatus : status,
            changeStatus ? "resource_unavailable" : "permission_denied",
          ),
        );
      },
    ),
  );
});
