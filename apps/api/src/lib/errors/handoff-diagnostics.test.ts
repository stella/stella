import { expect, test } from "bun:test";
import { inspect } from "node:util";

import { sanitizeErrorForOutput } from "@stll/errors";

import {
  sanitizeDiagnosticErrorForOutput,
  sanitizeHandoffDiagnosticText,
} from "@/api/lib/errors/handoff-diagnostics";

test("diagnostic output redacts handoff credentials without changing the original error", () => {
  const code = `sh1_${"a".repeat(43)}`;
  const cause = new TypeError(`Request ${code} refused`);
  const error = Object.assign(new Error(`Link ${code}`, { cause }), {
    detail: [code, { credential: code }],
  });
  const projected = sanitizeDiagnosticErrorForOutput({
    error,
    context: { code },
  });
  expect(inspect(projected)).not.toContain(code);
  expect(projected).toHaveProperty("error.message", "Link [redacted]");
  expect(projected).toHaveProperty(
    "error.cause.message",
    "Request [redacted] refused",
  );
  expect(projected).toHaveProperty("context.code", "[redacted]");
  expect(error.message).toContain(code);
  expect(cause.message).toContain(code);
  expect(error.detail).toEqual([code, { credential: code }]);
  expect(sanitizeHandoffDiagnosticText(`Request ${code} refused`)).toBe(
    "Request [redacted] refused",
  );
});

test("diagnostic projection retains query redaction and ordinary error metadata", () => {
  const output = sanitizeDiagnosticErrorForOutput({
    error: new TypeError("ordinary error"),
    diagnostic: "Failed query: SELECT private_value",
    query: "SELECT private_value",
    bigint: 1n,
    missing: undefined,
  });
  expect(output).toHaveProperty("error.name", "TypeError");
  expect(output).toHaveProperty("error.message", "ordinary error");
  expect(output).toHaveProperty(
    "diagnostic",
    "Database query failed (values redacted)",
  );
  expect(output).not.toHaveProperty("query");
  expect(output).toHaveProperty("bigint", 1n);
  expect(output).toHaveProperty("missing", undefined);
});

test("symbol-keyed error diagnostics redact descriptions while symbol values stay unsupported", () => {
  const code = `sh1_${"b".repeat(43)}`;
  const key = Symbol(`receipt ${code}`);
  const value = Symbol(`value ${code}`);
  const error = Object.assign(new Error(`Request ${code}`), {
    [key]: { detail: code, symbol: value },
    symbol: value,
  });
  // The shared projection retains Error symbol keys for diagnostic inspection.
  expect(
    inspect(sanitizeErrorForOutput(error), { showHidden: true }),
  ).toContain(code);
  const projected = sanitizeDiagnosticErrorForOutput(error);
  const diagnostic = inspect(projected, { showHidden: true });
  expect(diagnostic).not.toContain(code);
  expect(diagnostic).toContain("Symbol(receipt [redacted])");
  expect(projected).toHaveProperty("message", "Request [redacted]");
  expect(projected).toHaveProperty("symbol", "[unsupported]");
  expect(key.description).toContain(code);
  expect(value.description).toContain(code);
});
