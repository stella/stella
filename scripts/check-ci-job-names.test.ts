import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  checkCiJobNames,
  expressionRenderings,
  jobNamePatterns,
  patternsOverlap,
} from "./check-ci-job-names";

const SCRIPT = path.join(import.meta.dir, "check-ci-job-names.ts");
// `${{ <body> }}`, built so the test source holds no template placeholder.
const expression = (body: string) => `\${{ ${body} }}`;
const workflowJobs = () => {
  const workflow = Bun.YAML.parse(
    readFileSync(
      path.join(import.meta.dir, "../.github/workflows/ci.yml"),
      "utf-8",
    ),
  ) as { jobs: Record<string, Record<string, unknown>> };
  return workflow.jobs;
};

describe("expression renderings", () => {
  test("a literal choice renders only its literals", () => {
    expect(
      expressionRenderings(
        "github.event_name == 'pull_request' && (contains(fromJSON('[\"labeled\"]'), github.event.action) && !contains(fromJSON('[\"merge-armed\"]'), github.event.label.name)) && 'ci-metadata-plan' || 'ci-plan'",
      ),
    ).toEqual(["ci-metadata-plan", "ci-plan"]);
    expect(
      expressionRenderings("github.ref == 'main' && 'x' || 'it''s'"),
    ).toEqual(["x", "it's"]);
    expect(expressionRenderings("github.ref == 'main' && 'x'")).toEqual([
      "false",
      "x",
    ]);
  });

  test("context values, unknown functions and malformed text are unknown", () => {
    for (const source of [
      " matrix.os ",
      "github.event_name || 'x'",
      "format('{0}', matrix.os)",
      "'a' ||",
      "(('a')",
      "'unterminated",
      "",
    ]) {
      expect(expressionRenderings(source)).toBeNull();
    }
  });
});

describe("CI job names", () => {
  test("the current workflow's job names resolve and never collide", () => {
    const jobs = workflowJobs();
    expect(checkCiJobNames(jobs)).toEqual([]);
    const plan = jobNamePatterns("ci-plan", jobs["ci-plan"] ?? {});
    expect(plan.type).toBe("resolved");
    if (plan.type === "resolved") {
      expect(
        plan.patterns
          .map((pattern) =>
            pattern.map((piece) => (piece.type === "text" ? piece.text : "*")),
          )
          .map((pieces) => pieces.join(""))
          .filter((name) => !name.startsWith("${{")),
      ).toEqual(["ci-metadata-plan", "ci-plan"]);
    }
  });

  test("the command passes on the current workflow", () => {
    const result = Bun.spawnSync(["bun", SCRIPT], {
      cwd: path.join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("CI job names: OK.");
  });

  test("a literal-alternatives expression passes", () => {
    expect(
      checkCiJobNames({
        build: {
          name: expression(
            "github.event_name == 'push' && 'build-push' || 'build'",
          ),
        },
        test: {},
      }),
    ).toEqual([]);
  });

  test("a name of only a matrix value or an unknown context is unresolved", () => {
    expect(
      checkCiJobNames({
        lint: {
          name: expression("matrix.os"),
          strategy: { matrix: { os: ["linux", "macos"] } },
        },
        notes: { name: expression("github.event.inputs.title") },
        report: { name: `Report (${expression("matrix.os")})` },
      }),
    ).toEqual([
      `lint: unresolved name "${expression("matrix.os")}": only matrix values identify the job`,
      `notes: unresolved name "${expression("github.event.inputs.title")}": ${expression("github.event.inputs.title")} does not render a fixed set of names`,
      // A matrix reference needs a matrix.
      `report: unresolved name "Report (${expression("matrix.os")})": ${expression("matrix.os")} does not render a fixed set of names`,
    ]);
  });

  test("a matrix job keeps its matrix values in the name", () => {
    expect(
      checkCiJobNames({
        tests: { strategy: { matrix: { shard: [1, 2] } } },
        rust: {
          name: `Rust (${expression("matrix.os")})`,
          strategy: { matrix: { include: [{ os: "linux" }] } },
        },
      }),
    ).toEqual([]);
  });

  test("two jobs that can render the same name are ambiguous", () => {
    expect(
      checkCiJobNames({
        build: {},
        plan: {
          name: expression("github.event_name == 'push' && 'build' || 'plan'"),
        },
      }),
    ).toEqual(['plan: ambiguous name "build" can also be build\'s "build"']);
    // A job named like another job's matrix rendering collides too.
    expect(
      checkCiJobNames({
        tests: { strategy: { matrix: { shard: [1, 2] } } },
        first: { name: "tests (1)" },
      }),
    ).toEqual([
      'first: ambiguous name "tests (1)" can also be tests\'s "tests (<value>)"',
    ]);
  });

  test("overlap is exact for wildcards on both sides", () => {
    const text = (value: string) => ({ type: "text" as const, text: value });
    const any = { type: "any" as const };
    expect(
      patternsOverlap([text("a ("), any, text(")")], [text("a (x)")]),
    ).toBe(true);
    expect(patternsOverlap([text("a ("), any, text(")")], [text("a ()")])).toBe(
      false,
    );
    expect(patternsOverlap([text("x"), any], [any, text("y")])).toBe(true);
    expect(patternsOverlap([text("ab")], [text("abc")])).toBe(false);
  });
});
