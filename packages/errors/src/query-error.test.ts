import { expect, test } from "bun:test";

import { sanitizeErrorForOutput } from "./query-error";

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
  expect(projected.message).toBe(ordinary.message);
  expect(projected.stack).toBe(ordinary.stack);
  expect(projected).toMatchObject({
    operation: "fetch",
    diagnostic: { attempts: 1 },
    cause: { code: "ECONNRESET" },
  });
  expect(projected.cause).not.toBe(ordinary.cause);
});
