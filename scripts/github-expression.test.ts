import { describe, expect, test } from "bun:test";

import { UNKNOWN, definitelyFalse, evaluate } from "./github-expression";

const none = { values: {} };

describe("GitHub expression evaluation", () => {
  test("unpinned context is unknown and follows three-valued logic", () => {
    expect(evaluate("github.ref", none)).toBe(UNKNOWN);
    expect(evaluate("github.ref == 'x'", none)).toBe(UNKNOWN);
    expect(definitelyFalse("github.ref == 'x' && false", none)).toBe(true);
    expect(definitelyFalse("github.ref == 'x' || false", none)).toBe(false);
    expect(evaluate("github.ref == 'x' || true", none)).toBe(true);
    expect(evaluate("!(github.ref == 'x')", none)).toBe(UNKNOWN);
  });

  test("pinned values compare like GitHub: strings ignore case", () => {
    const context = {
      values: { "github.event_name": "Push", "github.run_attempt": 2 },
    };
    expect(evaluate("github.event_name == 'push'", context)).toBe(true);
    expect(evaluate("github.event_name != 'push'", context)).toBe(false);
    expect(evaluate("github.run_attempt >= 2", context)).toBe(true);
    expect(evaluate("github.run_attempt < 2", context)).toBe(false);
  });

  test("functions, literals and the expression wrapper", () => {
    const context = { values: { "github.event.workflow_run.event": "push" } };
    // Joined so the source holds no literal placeholder syntax.
    const wrapped = [
      "$",
      `{{ contains(fromJSON('["push", "schedule"]'), github.event.workflow_run.event) }}`,
    ].join("");
    expect(evaluate(wrapped, context)).toBe(true);
    expect(evaluate("startsWith('v1.2.3', 'V')", none)).toBe(true);
    expect(evaluate("endsWith('abc', 'x')", none)).toBe(false);
    expect(evaluate("contains('Release', 'lease')", none)).toBe(true);
    expect(evaluate("'it''s' == 'IT''S'", none)).toBe(true);
    expect(evaluate("null == null && true != false", none)).toBe(true);
    expect(evaluate("format('{0}', github.ref)", none)).toBe(UNKNOWN);
  });

  test("status functions are unknown unless pinned", () => {
    expect(evaluate("always()", none)).toBe(UNKNOWN);
    expect(
      evaluate("always() && success()", {
        values: {},
        status: { always: true, success: false },
      }),
    ).toBe(false);
    expect(
      evaluate("!cancelled()", { values: {}, status: { cancelled: false } }),
    ).toBe(true);
  });

  test("a fallback pins whole families of paths", () => {
    const context = {
      values: {},
      fallback: (path: string) =>
        path.startsWith("needs.a.outputs.") ? "" : undefined,
    };
    expect(evaluate("needs.a.outputs.anything == ''", context)).toBe(true);
    expect(evaluate("needs.b.outputs.anything == ''", context)).toBe(UNKNOWN);
  });

  test("unsupported syntax throws instead of guessing", () => {
    expect(() => evaluate("github.event['x'] == 'y'", none)).toThrow(
      "unexpected '['",
    );
    expect(() => evaluate("'unterminated", none)).toThrow(
      "unterminated string",
    );
    expect(() => evaluate("(a == b", none)).toThrow("expected )");
    expect(() => evaluate("a == b c", none)).toThrow("trailing tokens");
  });
});
