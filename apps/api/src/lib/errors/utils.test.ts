import { describe, expect, test } from "bun:test";

import {
  connectionErrorFields,
  errorFingerprint,
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

describe("errorFingerprint", () => {
  test("extracts the class, stable code, and a code-location frame", () => {
    const error = new TypeError("cannot read property 'x' of undefined");
    const fingerprint = errorFingerprint(error);
    expect(fingerprint["error.class"]).toBe("TypeError");
    // No `.code` property, so the stable code falls back to the tag.
    expect(fingerprint["error.code"]).toBe("TypeError");
    // The top frame is a `file:line:col` location, never user content.
    expect(fingerprint["error.frame"]).toMatch(/:\d+:\d+$/u);
    expect(fingerprint["error.frame"]).not.toContain("(");
  });

  test("prefers a `.code` string when present", () => {
    const error = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    expect(errorFingerprint(error)["error.code"]).toBe("ECONNRESET");
  });

  test("surfaces the deepest cause's top frame", () => {
    const root = new Error("root failure");
    const wrapped = new Error("wrapped", { cause: root });
    const fingerprint = errorFingerprint(wrapped);
    expect(fingerprint["error.cause.frame"]).toMatch(/:\d+:\d+$/u);
  });

  test("never throws on a missing or non-standard stack", () => {
    const noStack = new Error("boom");
    delete noStack.stack;
    expect(errorFingerprint(noStack)["error.frame"]).toBeUndefined();

    const minified = new Error("boom");
    minified.stack = "Error: boom\n    at <anonymous>";
    expect(errorFingerprint(minified)["error.frame"]).toBeUndefined();
  });

  test("handles non-Error values", () => {
    expect(errorFingerprint("boom")).toEqual({ "error.class": "UnknownError" });
  });

  // The fingerprint exists to survive the logger's PII redaction. If a
  // future key starts matching /(?:body|content|email|...)/i, it would
  // be silently dropped and 5xx would go dark again — this guards that.
  test("every fingerprint key survives the logger attribute sanitizer", () => {
    const error = new TypeError("cannot read property 'x' of undefined");
    const fingerprint = errorFingerprint(error);
    const sanitized = sanitizeLogAttributes(fingerprint);
    for (const [key, value] of Object.entries(fingerprint)) {
      expect(sanitized?.[key]).toBe(value);
    }
    expect(sanitized?.["log.attributes_dropped"]).toBeUndefined();
  });

  test("carries no message-bearing key (PII boundary)", () => {
    const error = new Error("privileged: alice uploaded merger-secret.docx");
    const fingerprint = errorFingerprint(error);
    expect(fingerprint["error.message"]).toBeUndefined();
    expect(fingerprint["error.msg"]).toBeUndefined();
    expect(fingerprint["error.stack"]).toBeUndefined();
    for (const value of Object.values(fingerprint)) {
      expect(value).not.toContain("merger-secret");
    }
  });
});
