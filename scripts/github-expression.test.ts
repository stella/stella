import { describe, expect, test } from "bun:test";

import {
  contextFromNested,
  contextWithPlanOutputs,
  definitelyFalse,
  evaluate,
  expressionValueSources,
  hasStatusCheckFunction,
  stepConditionCovers,
  UNKNOWN,
} from "./github-expression";

const none = { values: {} };

test.each([
  ["needs.plan.outputs.image", ["needs.plan.outputs.image"]],
  [
    "matrix.shard == 1 && needs.plan.outputs.required == 'true' && needs.plan.outputs.image || ''",
    ["needs.plan.outputs.image", ""],
  ],
  [
    "needs.plan.outputs.unresolved || needs.plan.outputs.image",
    ["needs.plan.outputs.unresolved", "needs.plan.outputs.image"],
  ],
  [
    "needs.plan.outputs.image || needs.plan.outputs.unresolved",
    ["needs.plan.outputs.image", "needs.plan.outputs.unresolved"],
  ],
  [
    "(needs.plan.outputs.required == 'true') || needs.plan.outputs.image",
    [true, "needs.plan.outputs.image"],
  ],
  ["false && needs.plan.outputs.unresolved || ''", [""]],
  ["format('{0}', needs.plan.outputs.image)", ["computed"]],
] as const)(
  "value provenance retains every possible source of %s",
  (source, expected) => {
    const values = expressionValueSources(source).map((value) => {
      switch (value.type) {
        case "reference":
          return value.path;
        case "literal":
          return value.value;
        case "computed":
          return "computed";
        default: {
          const exhaustive: never = value;
          return exhaustive;
        }
      }
    });
    expect([...new Set(values)]).toEqual([...expected]);
  },
);

test("gated images use GitHub operand-returning semantics for every shard and flag", () => {
  const source =
    "matrix.shard == 1 && needs.plan.outputs.required == 'true' && needs.plan.outputs.image || ''";
  for (const shard of [1, 2, 3]) {
    for (const required of ["true", "false", ""]) {
      const image = "docker.io/library/postgres:18";
      expect(
        evaluate(source, {
          values: {
            "matrix.shard": shard,
            "needs.plan.outputs.required": required,
            "needs.plan.outputs.image": image,
          },
        }),
      ).toBe(shard === 1 && required === "true" ? image : "");
    }
  }
});

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

  test("values of different types compare as GitHub coerces them", () => {
    // An unset job output renders as null; GitHub reads `null == ''` as true,
    // so a selection gate such as `outputs.x == '' || contains(...)` keeps
    // the step when the planner wrote no selection.
    const unset = {
      values: {},
      fallback: (path: string) =>
        path.startsWith("needs.plan.outputs.") ? null : undefined,
    };
    expect(evaluate("needs.plan.outputs.selection == ''", unset)).toBe(true);
    expect(evaluate("needs.plan.outputs.selection != ''", unset)).toBe(false);
    expect(evaluate("null == 0 && false == 0 && true == 1", none)).toBe(true);
    expect(evaluate("'1.5' == 1.5 && ' 2 ' == 2 && '' == false", none)).toBe(
      true,
    );
    expect(evaluate("'true' == true", none)).toBe(false);
    expect(evaluate("'abc' == 0 || 'abc' == null", none)).toBe(false);
    expect(evaluate("fromJSON('[]') == 0", none)).toBe(false);
    expect(evaluate("fromJSON('[]') == fromJSON('[]')", none)).toBe(false);
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

test("direct planner projections resolve from producer evidence and preserve literal defaults", () => {
  for (const source of ["[]", '["ci-checks-rest"]', ""]) {
    const context = contextWithPlanOutputs({
      context: { values: { "steps.heavy-plan.outputs.queue_jobs": source } },
      outputs: {
        queue_required_jobs: wrappedExpression(
          "steps.heavy-plan.outputs.queue_jobs || '[]'",
        ),
      },
    });
    expect(evaluate("needs.ci-plan.outputs.queue_required_jobs", context)).toBe(
      source || "[]",
    );
  }
});

test("status functions are identified structurally, including nested calls", () => {
  expect(hasStatusCheckFunction("contains('failure()', 'failure')")).toBe(
    false,
  );
  expect(hasStatusCheckFunction("contains(toJSON(failure()), 'true')")).toBe(
    true,
  );
});

test("coverage certificates hold across boolean inputs and status transitions", () => {
  const formulas = [
    "true",
    "false",
    "inputs.a",
    "!inputs.a",
    "inputs.a && inputs.b",
    "inputs.a || inputs.b",
    "!(inputs.a && inputs.b)",
    "inputs.a == true",
    "inputs.a != false",
    "success()",
    "failure()",
    "!cancelled()",
  ];
  const statuses = [false, true].flatMap((failure) =>
    [false, true].map((cancelled) => ({
      always: true,
      success: !failure && !cancelled,
      failure,
      cancelled,
    })),
  );
  let certificates = 0;
  for (const a of formulas) {
    for (const b of formulas) {
      const earlier = `always() && (${a})`;
      const later = `always() && (${b})`;
      if (!stepConditionCovers({ earlier, later, stableStepIds: new Set() })) {
        continue;
      }
      certificates += 1;
      for (const first of statuses) {
        for (const second of statuses) {
          if (
            (first.failure && !second.failure) ||
            (first.cancelled && !second.cancelled)
          ) {
            continue;
          }
          for (const x of [false, true]) {
            for (const y of [false, true]) {
              const values = { "inputs.a": x, "inputs.b": y };
              if (evaluate(later, { values, status: second }) === true) {
                expect(
                  evaluate(earlier, { values, status: first }),
                  `${earlier} covers ${later}`,
                ).toBe(true);
              }
            }
          }
        }
      }
    }
  }
  expect(certificates).toBeGreaterThan(0);
  expect(certificates).toBeLessThan(formulas.length ** 2);
});

test.each([
  "env.READY",
  "job.status",
  "github.action",
  "steps.future.outputs.ready",
])("changing step values cannot certify coverage: %s", (reference) => {
  const condition = `!cancelled() && ${reference} == 'ready'`;
  expect(
    stepConditionCovers({
      earlier: condition,
      later: condition,
      stableStepIds: new Set(),
    }),
  ).toBe(false);
});

test("completed step outputs can certify the same or a narrower condition", () => {
  expect(
    stepConditionCovers({
      earlier: "!cancelled() && steps.ready.outputs.status == 'ready'",
      later:
        "!cancelled() && steps.ready.outputs.status == 'ready' && inputs.enabled",
      stableStepIds: new Set(["ready"]),
    }),
  ).toBe(true);
});
