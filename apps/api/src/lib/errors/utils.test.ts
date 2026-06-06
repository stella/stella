import { describe, expect, test } from "bun:test";

import {
  connectionErrorFields,
  errorSystemFields,
} from "@/api/lib/errors/utils";
import { sanitizeLogAttributes } from "@/api/lib/observability/logger";

describe("errorSystemFields", () => {
  test("extracts the structural type and non-PII system codes", () => {
    const error = Object.assign(
      new Error("connect ECONNREFUSED 10.0.0.5:6379"),
      { code: "ECONNREFUSED", errno: -111, syscall: "connect" },
    );
    const fields = errorSystemFields(error);
    expect(fields["error.type"]).toBe("Error");
    expect(fields["error.code"]).toBe("ECONNREFUSED");
    expect(fields["error.errno"]).toBe("-111");
    expect(fields["error.syscall"]).toBe("connect");
  });

  // The whole reason errorSystemFields exists separately from
  // connectionErrorFields: it must stay safe for analytics sinks
  // that can observe handler/user-data errors. A regression that
  // folds the message in here would leak PII.
  test("never includes the raw message (PII boundary)", () => {
    const error = new Error("privileged: alice uploaded merger-secret.docx");
    const fields = errorSystemFields(error);
    expect(fields).not.toHaveProperty("error.message");
    expect(fields).not.toHaveProperty("error.msg");
  });

  test("surfaces the cause type and code", () => {
    const cause = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const fields = errorSystemFields(new Error("wrapped", { cause }));
    expect(fields["error.cause.type"]).toBe("Error");
    expect(fields["error.cause.code"]).toBe("ECONNRESET");
  });

  test("handles non-Error values", () => {
    expect(errorSystemFields("boom")).toEqual({ "error.type": "UnknownError" });
  });
});

describe("connectionErrorFields", () => {
  test("adds the message under error.msg on top of the system fields", () => {
    const error = Object.assign(new Error("Connection is closed"), {
      code: "ECONNRESET",
    });
    const fields = connectionErrorFields(error);
    expect(fields["error.msg"]).toBe("Connection is closed");
    expect(fields["error.code"]).toBe("ECONNRESET");
    expect(fields["error.type"]).toBe("Error");
  });

  test("omits an empty message", () => {
    const error = new Error("placeholder");
    error.message = "";
    expect(connectionErrorFields(error)).not.toHaveProperty("error.msg");
  });

  // Regression guard: the logger's sanitizer drops any key matching
  // /message/i, so the message must ride on `error.msg` to survive.
  // If anyone renames it back to `error.message`, this fails.
  test("error.msg survives the logger attribute sanitizer", () => {
    const error = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });
    const sanitized = sanitizeLogAttributes(connectionErrorFields(error));
    expect(sanitized?.["error.msg"]).toBe("read ECONNRESET");
    expect(sanitized?.["error.code"]).toBe("ECONNRESET");
    // Proves the drop the field name sidesteps is real.
    expect(sanitizeLogAttributes({ "error.message": "x" })).not.toHaveProperty(
      "error.message",
    );
  });
});
