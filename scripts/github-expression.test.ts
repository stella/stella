import { describe, expect, test } from "bun:test";

import {
  compileOutputAliases,
  conjunctiveOutputConditions,
  contextFromNested,
  contextWithPlanOutputs,
  definitelyFalse,
  evaluate,
  UNKNOWN,
} from "./github-expression";

const none = { values: {} };

describe("bounded output condition conjunctions", () => {
  const output = "needs.plan.outputs.selected";
  const outputs = new Map(
    [output, "needs.plan.outputs.other"].map(
      (reference) => [reference, reference] as const,
    ),
  );
  test.each([
    [[`${output} == 'true'`, `${output} == 'false'`], "contradictory"],
    [[`${output} == 'true'`, `${output} != 'true'`], "contradictory"],
    [[output, `${output} == ''`], "contradictory"],
    [
      [`${output} == 'TRUE'`, `(${output} == 'true') && !cancelled()`],
      "consistent",
    ],
    [[`${output} != 'false'`, `${output} == 'true'`], "consistent"],
    [
      [`${output} == 'true' || github.event_name == 'workflow_dispatch'`],
      "consistent",
    ],
    [[`!(${output} == 'false')`], "consistent"],
    [[`${output} == 'true'`, `!(${output} == 'true')`], "contradictory"],
    [[`contains(${output}, 'true')`], "unresolved"],
    [[`${output} == needs.plan.outputs.other`], "unresolved"],
    [["false"], "contradictory"],
    [[`${output} == 'true' &&`], "unresolved"],
    [[`(${output} == 'true') && (success() || failure())`], "consistent"],
  ] as const)("bounds %j as %s", (conditions, type) => {
    expect(
      conjunctiveOutputConditions({
        conditions,
        outputs,
        context: contextFromNested({
          cancelled: () => false,
          success: () => true,
          failure: () => false,
        }),
      }).type,
    ).toBe(type);
    expect(
      conjunctiveOutputConditions({
        conditions: [...conditions].toReversed(),
        outputs,
        context: contextFromNested({
          cancelled: () => false,
          success: () => true,
          failure: () => false,
        }),
      }).type,
    ).toBe(type);
  });

  test.each([
    "steps.check.outputs.trusted == 'true' || github.event_name == 'workflow_dispatch'",
    "needs.ci-plan.outputs.coverage_profile != 'pilot-fast-v1' || contains(fromJSON(needs.ci-plan.outputs.pilot_fast_jobs || '[]'), 'ci-browser')",
    "needs.ci-plan.outputs.suite_depth == 'full' || (needs.ci-plan.outputs.suite_depth == 'fast' && needs.ci-plan.outputs.service_suites_pr_required == 'true')",
  ])("keeps the real workflow alternatives consistent: %s", (condition) => {
    const registered = new Map(
      [
        "steps.check.outputs.trusted",
        "needs.ci-plan.outputs.coverage_profile",
        "needs.ci-plan.outputs.pilot_fast_jobs",
        "needs.ci-plan.outputs.suite_depth",
        "needs.ci-plan.outputs.service_suites_pr_required",
      ].map((reference) => [reference, reference] as const),
    );
    expect(
      conjunctiveOutputConditions({
        conditions: [condition],
        outputs: registered,
      }),
    ).toEqual({ type: "consistent" });
  });

  test("follows composite aliases without losing producer constraints", () => {
    const first = "needs.plan.outputs.first";
    const second = "needs.plan.outputs.second";
    const substitutions = compileOutputAliases({
      aliases: new Map([
        [first, { expression: `${output} == 'true'`, outputs }],
        [second, { expression: `${first} == 'true'`, outputs }],
      ]),
      boundReferences: new Set(),
    });
    expect(
      conjunctiveOutputConditions({
        conditions: [`${second} == 'true'`, `${output} == 'false'`],
        outputs,
        substitutions,
      }).type,
    ).toBe("contradictory");
    expect(
      conjunctiveOutputConditions({
        conditions: [`${second} == 'true'`, `${output} == 'true'`],
        outputs,
        substitutions,
      }).type,
    ).toBe("consistent");
  });

  test.each([
    ["needs.plan.outputs.boolean", "consistent"],
    ["!needs.plan.outputs.boolean", "contradictory"],
    ["needs.plan.outputs.boolean == 'false'", "contradictory"],
    ["needs.plan.outputs.boolean == 'true'", "consistent"],
    ["!needs.plan.outputs.copy", "contradictory"],
    ["needs.plan.outputs.possibly_empty", "unresolved"],
  ] as const)(
    "preserves job output string semantics: %s",
    (condition, type) => {
      const substitutions = compileOutputAliases({
        aliases: new Map([
          [
            "needs.plan.outputs.boolean",
            { expression: `${output} == 'true'`, outputs },
          ],
          [
            "needs.plan.outputs.copy",
            { expression: "needs.plan.outputs.boolean", outputs },
          ],
          [
            "needs.plan.outputs.possibly_empty",
            { expression: `${output} && ${output}`, outputs },
          ],
        ]),
        boundReferences: new Set(),
      });
      expect(
        conjunctiveOutputConditions({
          conditions: [`${output} == 'true'`, condition],
          outputs,
          substitutions,
        }).type,
      ).toBe(type);
    },
  );

  test("applies the DNF cap after substituting a composite alias", () => {
    const producers = new Map(
      Array.from(
        { length: 7 },
        (_, index) =>
          [`steps.scope.outputs.field${index}`, `scope/field${index}`] as const,
      ),
    );
    const expression = [...producers.keys()]
      .map((reference) => `(${reference} == 'a' || ${reference} == 'b')`)
      .join(" && ");
    const substitutions = compileOutputAliases({
      aliases: new Map([
        ["needs.scope.outputs.composite", { expression, outputs: producers }],
      ]),
      boundReferences: new Set(),
    });
    expect(
      conjunctiveOutputConditions({
        conditions: ["needs.scope.outputs.composite == 'true'"],
        outputs: producers,
        substitutions,
      }),
    ).toEqual({
      type: "unresolved",
      reason: "output condition DNF exceeds 64 disjuncts",
    });
  });

  test("caps DNF expansion before granting output consistency", () => {
    const registered = new Map(
      Array.from(
        { length: 7 },
        (_, index) =>
          [`needs.plan.outputs.field${index}`, `field${index}`] as const,
      ),
    );
    const condition = Array.from(
      { length: 7 },
      (_, index) =>
        `(needs.plan.outputs.field${index} == 'a' || needs.plan.outputs.field${index} == 'b')`,
    ).join(" && ");
    expect(
      conjunctiveOutputConditions({
        conditions: [condition],
        outputs: registered,
      }),
    ).toEqual({
      type: "unresolved",
      reason: "output condition DNF exceeds 64 disjuncts",
    });
    expect(
      conjunctiveOutputConditions({
        conditions: [
          condition.replace(
            "needs.plan.outputs.field6 == 'a' || needs.plan.outputs.field6 == 'b'",
            "true",
          ),
        ],
        outputs: registered,
      }).type,
    ).toBe("consistent");
  });

  test("producer identities bind constraints across output aliases", () => {
    const first = "needs.plan.outputs.selected_a";
    const second = "needs.plan.outputs.selected_b";
    const aliases = new Map([
      [first, "plan/steps.selection.outputs.required"],
      [second, "plan/steps.selection.outputs.required"],
    ]);
    expect(
      conjunctiveOutputConditions({
        conditions: [`${first} == 'true'`, `${second} == 'false'`],
        outputs: aliases,
      }).type,
    ).toBe("contradictory");
    expect(
      conjunctiveOutputConditions({
        conditions: [`${first} == 'true'`, `${second} == 'true'`],
        outputs: aliases,
      }).type,
    ).toBe("consistent");
  });
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
