import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

const root = path.resolve(import.meta.dir, "..");
const nightlyPath = ".github/workflows/nightly-test.yml";
const readWorkflow = (source: string) =>
  v.parse(
    v.object({ jobs: v.record(v.string(), v.unknown()) }),
    Bun.YAML.parse(source),
  ).jobs;
const ci = readWorkflow(
  readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf-8"),
);
const nightly = readWorkflow(
  readFileSync(path.join(root, nightlyPath), "utf-8"),
);
const git = (args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
};
const requiredSet = (jobs: Record<string, unknown>) => {
  const job = v.parse(
    v.object({
      needs: v.array(v.string()),
      steps: v.array(
        v.object({
          name: v.optional(v.string()),
          env: v.optional(v.record(v.string(), v.string())),
        }),
      ),
    }),
    jobs["ci-result"],
  );
  const env = job.steps.find(({ name }) => name === "Evaluate CI outcome")?.env;
  return {
    needs: new Set(job.needs),
    scopes: JSON.parse(env?.["JOB_SCOPES"] ?? ""),
    fast: new Set(
      v.parse(v.array(v.string()), JSON.parse(env?.["FAST_REQUIRED"] ?? "")),
    ),
  };
};

// The commit that moved the advisory job into the nightly workflow. Commits are
// immutable, so pinning it cannot drift. Searching history for it instead would
// fetch every past blob of the workflow in the blobless CI checkout.
const advisoryMoveCommit = "bc81bdb1b1960a654993ad47f3aeb6ddca5f6244";

test("moving the advisory job preserves the exact required CI set", () => {
  git(["cat-file", "-e", `${advisoryMoveCommit}^{commit}`]);
  const before = readWorkflow(
    git(["show", `${advisoryMoveCommit}^:.github/workflows/ci.yml`]),
  );
  const after = readWorkflow(
    git(["show", `${advisoryMoveCommit}:.github/workflows/ci.yml`]),
  );
  const nightlyBefore = readWorkflow(
    git(["show", `${advisoryMoveCommit}^:${nightlyPath}`]),
  );
  const nightlyAfter = readWorkflow(
    git(["show", `${advisoryMoveCommit}:${nightlyPath}`]),
  );
  expect(nightlyBefore).not.toHaveProperty("migration-exact-base-upgrade");
  expect(nightlyAfter).toHaveProperty("migration-exact-base-upgrade");
  expect(git(["show", `${advisoryMoveCommit}:${nightlyPath}`])).toContain(
    "\n  migration-exact-base-upgrade:",
  );
  expect(requiredSet(after)).toEqual(requiredSet(before));
  const advisory = "migration-exact-base-upgrade";
  expect(
    v.parse(
      v.object({ "continue-on-error": v.literal(true) }),
      before[advisory],
    ),
  ).toEqual({ "continue-on-error": true });
  expect(after).not.toHaveProperty(advisory);
  for (const jobs of [before, after, ci]) {
    const required = requiredSet(jobs);
    expect(required.needs).not.toContain(advisory);
    expect(required.scopes).not.toHaveProperty(advisory);
    expect(required.fast).not.toContain(advisory);
  }
}, 30_000);

test("nightly rehearsal checks main without granting issue permissions", () => {
  const job = v.parse(
    v.object({
      permissions: v.record(v.string(), v.string()),
      steps: v.array(
        v.object({
          name: v.string(),
          uses: v.optional(v.string()),
          run: v.optional(v.string()),
          with: v.optional(v.record(v.string(), v.unknown())),
          env: v.optional(v.record(v.string(), v.string())),
        }),
      ),
    }),
    nightly["migration-exact-base-upgrade"],
  );
  expect(job.permissions).toEqual({ contents: "read", packages: "read" });
  expect(
    job.steps.find(({ name }) => name === "Checkout")?.with,
  ).not.toHaveProperty("ref");
  const resolveMain = job.steps.find(
    ({ name }) => name === "Resolve previous main state",
  )?.run;
  expect(resolveMain).toContain(
    "git fetch --no-tags origin refs/heads/main\ngit checkout --detach FETCH_HEAD\n",
  );
  expect(
    job.steps.find(
      ({ name }) => name === "Rehearse exact-base migration upgrade",
    )?.env?.["BASE_SHA"],
  ).toBe(`\${{ steps.base.outputs.sha }}`);
  expect(nightly).not.toHaveProperty("report-failure");
  for (const configuredJob of Object.values(nightly)) {
    const permissions = v.parse(
      v.object({
        permissions: v.optional(v.record(v.string(), v.string())),
      }),
      configuredJob,
    ).permissions;
    expect(permissions).not.toHaveProperty("issues");
  }
});
