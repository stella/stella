import { expect, test } from "bun:test";
import { inspect } from "node:util";

import { sanitizeErrorForOutput, sanitizeQueryErrorText } from "./query-error";

test("standalone database diagnostics hide row values and retain schema metadata", () => {
  const value = "fixture-diagnostic-value";
  const error = Object.assign(new Error("Constraint failure"), {
    name: "PostgresError",
    code: "23505",
    constraint: "account_token_unique",
    detail: `Key (token)=(${value}) already exists`,
  });
  expect(inspect(error)).toContain(value);
  const projected = sanitizeErrorForOutput(error);
  expect(inspect(projected)).not.toContain(value);
  expect(JSON.stringify(projected)).not.toContain(value);
  expect(projected).toMatchObject({
    code: "23505",
    constraint: "account_token_unique",
  });
  expect(error.detail).toContain(value);
});

test("query parameter values are redacted in sibling diagnostics", () => {
  const parameter = "fixture-query-value";
  const query = Object.assign(new Error("Database operation failed"), {
    name: "DrizzleQueryError",
    query: "select $1",
    params: [parameter],
  });
  expect(sanitizeErrorForOutput([{ diagnostic: parameter }, query])).toEqual([
    { diagnostic: "[redacted]" },
    expect.any(Error),
  ]);
  const wrapper = Object.assign(new Error("Request failed", { cause: query }), {
    [Symbol(parameter)]: true,
  });
  expect(inspect(sanitizeErrorForOutput(wrapper))).not.toContain(parameter);
  expect(query.params).toEqual([parameter]);
});

test("ordinary errors retain their diagnostics in a fresh projection", () => {
  const ordinary = Object.assign(
    new Error("Network failed", {
      cause: { code: "ECONNRESET" },
    }),
    { operation: "fetch", diagnostic: { attempts: 1 } },
  );
  const projected = sanitizeErrorForOutput(ordinary);
  expect(projected).not.toBe(ordinary);
  expect(projected).toBeInstanceOf(Error);
  if (!(projected instanceof Error)) {
    throw new TypeError("Expected an error output projection");
  }
  expect(projected.name).toBe(ordinary.name);
  // A sparse array's length must not drive the projection's work.
  const rows: unknown[] = [];
  rows.length = 1_000_000_000;
  const sparse = Object.assign(new Error("Batch failed"), { rows });
  expect(sanitizeErrorForOutput(sparse)).toHaveProperty("rows.length", 1001);
  // Worker exit diagnostics report this name as the error type.
  expect(sanitizeErrorForOutput(new TypeError("bad input"))).toHaveProperty(
    "name",
    "TypeError",
  );
  expect(projected.message).toBe(ordinary.message);
  expect(projected.stack).toBe(ordinary.stack);
  expect(projected).toMatchObject({
    operation: "fetch",
    diagnostic: { attempts: 1 },
    cause: { code: "ECONNRESET" },
  });
  expect(projected.cause).not.toBe(ordinary.cause);
});

test("handoff credentials are removed from diagnostic text and nested output", () => {
  const code = `sh1_${"a".repeat(43)}`;
  expect(sanitizeQueryErrorText(`Request ${code} refused`)).toBe(
    "Request [redacted] refused",
  );
  expect(
    JSON.stringify(
      sanitizeErrorForOutput({ detail: code, message: `Request ${code}` }),
    ),
  ).not.toContain(code);
});
