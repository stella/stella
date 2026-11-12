import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const workflows = new URL("../.github/workflows/", import.meta.url);

// A dispatch names its run only when asked for run details, and may omit it
// even then. Every script that follows a dispatched run asks for the details,
// falls back to finding the run by listing, and never fails because the
// answer named no run.
test("every followed dispatch finds its run without relying on the answer", () => {
  const followers = readdirSync(workflows)
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((name) => ({
      name,
      text: readFileSync(new URL(name, workflows), "utf-8"),
    }))
    .filter(({ text }) => text.includes("workflow_run_id"));
  expect(followers.map(({ name }) => name).toSorted()).toEqual([
    "autofix-generated-conflicts.yml",
    "deploy-outlook-addin.yml",
    "marketing-screenshots-update.yml",
  ]);
  for (const { name, text } of followers) {
    expect(text, name).toContain("return_run_details: true");
    expect(text, name).toContain("github.rest.actions.listWorkflowRuns({");
    expect(text, name).toMatch(/created: `>=\$\{since\}`/u);
    expect(text, name).not.toMatch(/returned no run id/u);
  }
});

// A run named by its dispatch can read as Not Found for a moment; the
// follower waits for it rather than failing on the first read.
test("a followed deploy run tolerates a not-yet-visible run", () => {
  const text = readFileSync(
    new URL("deploy-outlook-addin.yml", workflows),
    "utf-8",
  );
  expect(text).toMatch(/error\?\.status !== 404/u);
  expect(text).not.toMatch(
    /const \{ data: run \} = await github\.rest\.actions\.getWorkflowRun/u,
  );
});
