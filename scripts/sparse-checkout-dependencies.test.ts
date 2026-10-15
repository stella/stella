import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// A sparse checkout materializes only the listed paths, so a listed script
// that calls a sibling (`$(dirname "${BASH_SOURCE[0]}")/gh-retry.sh`,
// `$script_dir/x.sh`) fails with exit 127 at run time unless the sibling is
// listed too. Follow those references transitively for every sparse checkout.
const SIBLING_REFERENCE =
  /(?:\$\(dirname (?:-- )?"(?:\$\{BASH_SOURCE\[0\]\}|\$0)"\)|\$\{?script_dir\}?)\/([\w./-]+\.(?:sh|jq))/gu;

const root = path.resolve(import.meta.dir, "..");

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const siblingReferences = (file: string, source: string): string[] =>
  Array.from(source.matchAll(SIBLING_REFERENCE), ([, target = ""]) =>
    path.posix.normalize(path.posix.join(path.posix.dirname(file), target)),
  );

const isCovered = (file: string, listed: readonly string[]): boolean =>
  listed.some(
    (entry) =>
      entry === file || file.startsWith(`${entry.replace(/\/$/u, "")}/`),
  );

const uncoveredDependencies = (listed: readonly string[]): string[] => {
  const missing = new Set<string>();
  const seen = new Set<string>();
  const pending = listed.filter((entry) => entry.endsWith(".sh"));
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const absolute = path.join(root, file);
    if (!existsSync(absolute) || statSync(absolute).isDirectory()) {
      continue;
    }
    for (const target of siblingReferences(
      file,
      readFileSync(absolute, "utf-8"),
    )) {
      if (!isCovered(target, listed)) {
        missing.add(target);
      }
      pending.push(target);
    }
  }
  return [...missing].toSorted();
};

const workflowFiles = (): string[] =>
  [
    ...new Bun.Glob(".github/workflows/*.yml").scanSync({ cwd: root }),
    ...new Bun.Glob(".github/actions/*/action.yml").scanSync({ cwd: root }),
  ].toSorted();

test("sibling references resolve relative to the referencing script", () => {
  expect(
    siblingReferences(
      "scripts/a.sh",
      [
        `x="\${GH_RETRY_SCRIPT:-$(dirname "\${BASH_SOURCE[0]}")/gh-retry.sh}"`,
        'bash "$script_dir/b.sh"',
        `source "$(dirname -- "\${BASH_SOURCE[0]}")/../lib/c.sh"`,
        'jq -f "$script_dir/gate.jq"',
        'r="$(dirname "$0")/d.sh"',
      ].join("\n"),
    ),
  ).toEqual([
    "scripts/gh-retry.sh",
    "scripts/b.sh",
    "lib/c.sh",
    "scripts/gate.jq",
    "scripts/d.sh",
  ]);
});

test("every sparse checkout includes the scripts its listed scripts call", () => {
  const problems: string[] = [];
  let checkouts = 0;
  for (const file of workflowFiles()) {
    const parsed: unknown = Bun.YAML.parse(
      readFileSync(path.join(root, file), "utf-8"),
    );
    if (!record(parsed)) {
      continue;
    }
    const jobs = record(parsed["jobs"]) ? parsed["jobs"] : {};
    const runs = parsed["runs"];
    const stepLists = [
      ...Object.values(jobs).map((job) => (record(job) ? job["steps"] : [])),
      record(runs) ? runs["steps"] : [],
    ];
    for (const steps of stepLists) {
      for (const step of Array.isArray(steps) ? steps.filter(record) : []) {
        const settings = step["with"];
        if (
          !record(settings) ||
          typeof settings["sparse-checkout"] !== "string"
        ) {
          continue;
        }
        checkouts += 1;
        const listed = settings["sparse-checkout"]
          .split("\n")
          .map((line) => line.trim().replace(/^\//u, ""))
          .filter(Boolean);
        for (const missing of uncoveredDependencies(listed)) {
          problems.push(`${file}: sparse checkout lacks ${missing}`);
        }
      }
    }
  }
  expect(checkouts).toBeGreaterThan(0);
  expect(problems).toEqual([]);
});
