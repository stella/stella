import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

import { ciExpressionContext } from "./ci-expression-context";
import { contextFromNested, evaluate, UNKNOWN } from "./github-expression";

const expressionPaths =
  /\b(?:github|inputs|vars)\.[\w.*-]+|\bsteps\.[\w-]+\.(?:outputs\.[\w-]+|outcome)|\bneeds\.[\w-]+\.(?:result|outputs\.[\w-]+)/gu;

const workflowSchema = v.object({
  jobs: v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      outputs: v.optional(v.record(v.string(), v.string())),
    }),
  ),
});
const workflow = v.parse(
  workflowSchema,
  Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf-8",
    ),
  ),
);

export const unresolvedCiExpressionPaths = (context: object) => {
  const model = contextFromNested(context);
  const unresolved: string[] = [];
  for (const [job, definition] of Object.entries(workflow.jobs)) {
    const expressions = [
      ...(definition.if === undefined ? [] : [definition.if]),
      ...Object.values(definition.outputs ?? {}),
    ];
    const paths = new Set(
      expressions.flatMap(
        (expression) => expression.match(expressionPaths) ?? [],
      ),
    );
    for (const path of paths) {
      if (evaluate(path, model) === UNKNOWN) {
        unresolved.push(`${job}: ${path}`);
      }
    }
  }
  return unresolved;
};

test("every CI job expression path is represented for pull requests and merge groups", () => {
  for (const event of ["pull_request", "merge_group"] as const) {
    expect(unresolvedCiExpressionPaths(ciExpressionContext({ event }))).toEqual(
      [],
    );
  }
});

test("the census names a context path removed from the model", () => {
  const context = ciExpressionContext();
  delete context.steps["completed-depth"]?.outputs["marker"];
  expect(unresolvedCiExpressionPaths(context)).toContain(
    "ci-plan: steps.completed-depth.outputs.marker",
  );
});

test("the pull request author path is represented for repairable-drift checks", () => {
  const context = contextFromNested(
    ciExpressionContext({ event: "pull_request" }),
  );
  expect(evaluate("github.event.pull_request.user.login", context)).toBe(
    "contributor",
  );
});
