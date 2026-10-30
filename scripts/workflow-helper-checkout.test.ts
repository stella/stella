import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// Jobs check helper scripts out into .gh-retry, then check the source out
// into the workspace root, which removes .gh-retry. A helper that a later
// step still needs is copied to RUNNER_TEMP first; this finds any step that
// reads .gh-retry after such a root checkout.
const workflowsDirectory = path.join(
  import.meta.dirname,
  "../.github/workflows",
);
const helperPath = ".gh-retry";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

const helperReadsAfterRootCheckout = (source: string, file: string) => {
  const offenders: string[] = [];
  const jobs = record(record(Bun.YAML.parse(source))["jobs"]);
  for (const [job, definition] of Object.entries(jobs)) {
    let helper = false;
    let removed = false;
    for (const value of list(record(definition)["steps"])) {
      const step = record(value);
      if (text(step["uses"]).startsWith("actions/checkout@")) {
        const checkoutPath = record(step["with"])["path"];
        if (checkoutPath === helperPath) {
          helper = true;
          removed = false;
        } else if (checkoutPath === undefined && helper) {
          removed = true;
        }
        continue;
      }
      if (removed && JSON.stringify(step).includes(`${helperPath}/`)) {
        offenders.push(`${file} ${job}: ${text(step["name"])}`);
      }
    }
  }
  return offenders;
};

test("no step reads the helper checkout after a root checkout removed it", () => {
  const offenders = readdirSync(workflowsDirectory)
    .filter((file) => file.endsWith(".yml"))
    .flatMap((file) =>
      helperReadsAfterRootCheckout(
        readFileSync(path.join(workflowsDirectory, file), "utf-8"),
        file,
      ),
    );
  expect(offenders).toEqual([]);
});

test("the check finds a helper read after a root checkout", () => {
  const workflow = `
jobs:
  promote:
    steps:
      - uses: actions/checkout@v1
        with:
          path: .gh-retry
      - name: Preserved
        run: cp .gh-retry/scripts/a.sh "$RUNNER_TEMP/a.sh"
      - uses: actions/checkout@v1
      - name: Preserved copy
        run: bash "$RUNNER_TEMP/a.sh"
      - name: Removed helper
        run: bash .gh-retry/scripts/a.sh
`;
  expect(helperReadsAfterRootCheckout(workflow, "fixture.yml")).toEqual([
    "fixture.yml promote: Removed helper",
  ]);
});
