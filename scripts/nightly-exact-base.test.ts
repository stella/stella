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

// The exact-base upgrade rehearsal is advisory: it runs in the nightly
// workflow and never in the required CI set. The commit that moved it
// (bc81bdb1b19) proved that move kept the required set unchanged; this keeps
// it true on the live workflows, without reading history in the blobless CI
// checkout.
test("the advisory upgrade rehearsal runs nightly and stays out of the required CI set", () => {
  const advisory = "migration-exact-base-upgrade";
  expect(nightly).toHaveProperty(advisory);
  expect(ci).not.toHaveProperty(advisory);
  const required = requiredSet(ci);
  expect(required.needs).not.toContain(advisory);
  expect(required.scopes).not.toHaveProperty(advisory);
  expect(required.fast).not.toContain(advisory);
});

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
