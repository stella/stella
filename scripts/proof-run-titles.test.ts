import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { evaluate } from "./github-expression";

// Proof runs are found by display title: the run-name of each workflow is
// the producer, and every reader below must accept exactly what it renders.
const SHA = "a".repeat(40);
const RC = "v1.2.3-rc.4";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf-8");
const runName = (workflow: string) => {
  const parsed: unknown = Bun.YAML.parse(
    read(`../.github/workflows/${workflow}`),
  );
  const value =
    typeof parsed === "object" && parsed !== null
      ? Reflect.get(parsed, "run-name")
      : undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${workflow} declares no run-name`);
  }
  return value;
};
const render = (template: string, values: Record<string, string>) =>
  template.replaceAll(/\$\{\{([\s\S]*?)\}\}/gu, (_, expression: string) => {
    const result = evaluate(expression, { values });
    if (typeof result !== "string") {
      throw new TypeError(`run-name did not render: ${expression}`);
    }
    return result;
  });

const staging = runName("deploy-staging.yml");
const candidateStaging = render(staging, {
  "inputs.release_ref": RC,
  "inputs.sha": SHA,
  "github.sha": "b".repeat(40),
});
const ordinaryStaging = render(staging, {
  "inputs.release_ref": "",
  "inputs.sha": SHA,
  "github.sha": "b".repeat(40),
});
const shaOnly = { "inputs.sha": SHA, "github.sha": "b".repeat(40) };
const heavy = render(runName("main-heavy.yml"), shaOnly);
const prDepth = render(runName("main-pr-depth.yml"), shaOnly);

test("finalize eligibility reads the commit and candidate from every proof title", () => {
  const source = read("release-finalize-eligibility.sh");
  const pattern = /^title_pattern='(.+)'$/mu.exec(source)?.[1];
  expect(pattern).toBeDefined();
  const title = new RegExp(pattern ?? "", "u");
  expect(title.exec(candidateStaging)?.slice(2)).toEqual([RC, SHA]);
  for (const proof of [heavy, prDepth]) {
    expect(title.exec(proof)?.[3]).toBe(SHA);
  }
  // An ordinary staging deploy never finalizes a candidate.
  expect(title.test(ordinaryStaging)).toBe(false);
});

test("the staging owner gate tells candidate and ordinary runs apart", () => {
  const source = read("staging-owner.sh");
  const prefixes = [...source.matchAll(/startswith\(\\"([^\\]+)\\"\)/gu)].map(
    ([, prefix]) => prefix ?? "",
  );
  expect(prefixes).toEqual([
    "Staging release proof ",
    "Deploy main to staging ",
  ]);
  expect(candidateStaging.startsWith(prefixes[0] ?? "")).toBe(true);
  expect(ordinaryStaging.startsWith(prefixes[0] ?? "")).toBe(false);
  expect(ordinaryStaging.startsWith(prefixes[1] ?? "")).toBe(true);
});

test("the staging status writer finds both staging titles for their commit", () => {
  const source = read("post-staging-verification.sh");
  const definition = /^\s*(def deploys\(\$commit\):[\s\S]+?\$"\);)$/mu.exec(
    source,
  )?.[1];
  expect(definition).toBeDefined();
  const deploys = (title: string, commit: string) => {
    const result = Bun.spawnSync([
      "jq",
      "-n",
      "--arg",
      "title",
      title,
      "--arg",
      "commit",
      commit,
      `${definition ?? ""} $title | deploys($commit)`,
    ]);
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  expect(deploys(candidateStaging, SHA)).toBe("true");
  expect(deploys(ordinaryStaging, SHA)).toBe("true");
  expect(deploys(candidateStaging, "c".repeat(40))).toBe("false");
  expect(deploys(`Staging release proof ${SHA}`, SHA)).toBe("false");
});

test("the release health check accepts each proof workflow's rendered title", () => {
  const source = read("check-release-main-health.sh");
  const patterns = new Map(
    [
      ...source.matchAll(
        /validate_workflow_status "[^"]+" "\.github\/workflows\/([^"]+)" "([^"]+)"/gu,
      ),
    ].map(([, workflow, pattern]) => [workflow, pattern]),
  );
  for (const [workflow, title] of [
    ["deploy-staging.yml", candidateStaging],
    ["main-heavy.yml", heavy],
    ["main-pr-depth.yml", prDepth],
  ] as const) {
    const pattern = patterns.get(workflow);
    expect(pattern, workflow).toBeDefined();
    expect(new RegExp(`^(${pattern ?? ""}) ${SHA}$`, "u").test(title)).toBe(
      true,
    );
  }
});
