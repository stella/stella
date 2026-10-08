import { describe, expect, test } from "bun:test";

import {
  UNKNOWN,
  contextFromNested,
  contextWithPlanOutputs,
  definitelyFalse,
  evaluate,
} from "./github-expression";

const none = { values: {} };

describe("GitHub expression evaluation", () => {
  test("nested contexts preserve projections, status functions and unknown paths", () => {
    const context = contextFromNested({
      github: {
        event: {
          pull_request: { labels: [{ name: "prove-fix" }, { name: "other" }] },
        },
      },
      needs: { "ci-plan": { outputs: { trusted: "true" } } },
      always: () => true,
      cancelled: () => false,
    });
    expect(
      evaluate(
        "contains(github.event.pull_request.labels.*.name, 'prove-fix')",
        context,
      ),
    ).toBe(true);
    expect(
      evaluate(
        "needs.ci-plan.outputs.trusted == 'true' && always() && !cancelled()",
        context,
      ),
    ).toBe(true);
    expect(evaluate("github.event.pull_request.missing", context)).toBe(
      UNKNOWN,
    );
    expect(
      evaluate("github.event.pull_request.labels.*.missing", context),
    ).toEqual([]);
    expect(
      evaluate(
        "contains(github.event.pull_request.labels.*.name, 'prove-fix')",
        contextFromNested({
          github: { event: { pull_request: { labels: [] } } },
        }),
      ),
    ).toBe(false);
    expect(evaluate("github.event.pull_request.labels.name", context)).toBe(
      UNKNOWN,
    );
    expect(
      evaluate("github.event.pull_request.labels.name.name", context),
    ).toBe(UNKNOWN);
    expect(() => contextFromNested({ always: () => "yes" })).toThrow(
      "Invalid GitHub status function result",
    );
  });

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

const wrappedExpression = (expression: string) =>
  ["$", "{{ ", expression, " }}"].join("");

test("computed planner outputs derive from direct projections even when fixture pins disagree", () => {
  const outputs = {
    scope: wrappedExpression("steps.files.outputs.scope"),
    computed: wrappedExpression("steps.files.outputs.scope == 'true'"),
  };
  for (const scope of ["true", "false"]) {
    for (const pin of ["true", "false"]) {
      const contexts = [
        {
          values: {
            "needs.ci-plan.outputs.scope": scope,
            "needs.ci-plan.outputs.computed": pin,
          },
        },
        contextFromNested({
          needs: { "ci-plan": { outputs: { scope, computed: pin } } },
        }),
      ];
      for (const context of contexts) {
        expect(
          evaluate(
            "needs.ci-plan.outputs.computed",
            contextWithPlanOutputs({ context, outputs }),
          ),
        ).toBe(scope);
      }
    }
  }
});

test("unresolved computed inputs stay unknown rather than accepting an all-planned fixture", () => {
  const context = contextWithPlanOutputs({
    context: { values: { "needs.ci-plan.outputs.computed": "true" } },
    outputs: {
      computed: wrappedExpression("steps.files.outputs.scope == 'true'"),
    },
  });
  expect(evaluate("needs.ci-plan.outputs.computed", context)).toBe(UNKNOWN);
  expect(evaluate("false && needs.ci-plan.outputs.computed", context)).toBe(
    false,
  );
});

test("a projected output with a literal default supplies computed inputs", () => {
  const context = contextWithPlanOutputs({
    context: {
      values: {
        "needs.ci-plan.outputs.queue_depth": "thin",
        "needs.ci-plan.outputs.computed": "false",
      },
    },
    outputs: {
      queue_depth: wrappedExpression(
        "steps.depth.outputs.queue_depth || 'full'",
      ),
      computed: wrappedExpression("steps.depth.outputs.queue_depth == 'thin'"),
    },
  });
  expect(evaluate("needs.ci-plan.outputs.computed", context)).toBe("true");
});
