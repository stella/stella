import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";

const stepSchema = v.looseObject({
  name: v.string(),
  id: v.optional(v.string()),
  if: v.optional(v.string()),
  run: v.optional(v.string()),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
  env: v.optional(v.record(v.string(), v.string())),
});
const workflowSchema = v.looseObject({
  permissions: v.record(v.string(), v.string()),
  jobs: v.record(
    v.string(),
    v.looseObject({
      permissions: v.record(v.string(), v.string()),
      env: v.optional(v.record(v.string(), v.string())),
      steps: v.array(stepSchema),
    }),
  ),
});

const workflow = v.parse(
  workflowSchema,
  Bun.YAML.parse(
    readFileSync(
      new URL(
        "../../../.github/workflows/catalogue-upstream.yml",
        import.meta.url,
      ),
      "utf-8",
    ),
  ),
);
const precedent = v.parse(
  workflowSchema,
  Bun.YAML.parse(
    readFileSync(
      new URL(
        "../../../.github/workflows/model-catalog-check.yml",
        import.meta.url,
      ),
      "utf-8",
    ),
  ),
);
const steps = Object.values(workflow.jobs).flatMap(
  ({ steps: jobSteps }) => jobSteps,
);
const precedentSteps = Object.values(precedent.jobs).flatMap(
  ({ steps: jobSteps }) => jobSteps,
);
const commandStep = (command: string) =>
  v.parse(
    stepSchema,
    steps.find(({ run }) => run?.includes(command)),
  );

// The maintained proposal is also invoked for an empty diff so refresh-pr can
// close stale proposals. Gating any of these steps on revision counts breaks it.
test("refreshes and validates pinned facts even when no upstream revision advances", () => {
  const bump = commandStep("catalogue generate");
  const refresh = commandStep("catalogue refresh-pinned");
  const check = commandStep("catalogue check-pinned");
  expect(bump.if).toContain("update_count");
  expect(refresh.if).toBeUndefined();
  expect(check.if).toBeUndefined();
  expect(check.env).toBeUndefined();
  expect(steps.indexOf(bump)).toBeLessThan(steps.indexOf(refresh));
  expect(steps.indexOf(refresh)).toBeLessThan(steps.indexOf(check));

  const proposals = steps.filter(
    ({ with: options }) => options?.mode === "refresh-pr",
  );
  expect(proposals).toHaveLength(1);
  expect(
    steps.filter(({ uses }) => uses?.includes("/signed-commit@")),
  ).toHaveLength(1);
  const proposal = v.parse(stepSchema, proposals.at(0));
  expect(proposal.with?.branch).toBe("catalogue/upstream-revs");
  expect(proposal.if).not.toContain("update_count");
  expect(proposal.if).not.toContain("changed");
  expect(proposal.if).toBe("steps.app-token.outcome == 'success'");
  expect(steps.indexOf(check)).toBeLessThan(steps.indexOf(proposal));
});

test("uses the reviewed app-token producer so the refresh PR triggers CI", () => {
  const app = v.parse(
    stepSchema,
    steps.find(({ uses }) =>
      uses?.startsWith("actions/create-github-app-token@"),
    ),
  );
  const precedentApp = v.parse(
    stepSchema,
    precedentSteps.find(({ uses }) =>
      uses?.startsWith("actions/create-github-app-token@"),
    ),
  );
  expect(app.uses).toBe(precedentApp.uses);
  expect(app.with).toEqual(precedentApp.with);
  expect(app.id).toBe("app-token");
  expect(app.if).toContain("github.repository == 'stella/stella'");
  expect(app.if).toContain("github.ref == 'refs/heads/main'");
  expect(app.if).not.toContain("update_count");

  const proposal = v.parse(
    stepSchema,
    steps.find(({ with: options }) => options?.mode === "refresh-pr"),
  );
  const precedentProposal = v.parse(
    stepSchema,
    precedentSteps.find(({ with: options }) => options?.mode === "refresh-pr"),
  );
  expect(proposal.uses).toBe(precedentProposal.uses);
  expect(proposal.with?.token).toBe(precedentProposal.with?.token);
  expect(workflow.permissions).toEqual({});
  for (const job of Object.values(workflow.jobs)) {
    expect(job.permissions).toEqual({ contents: "read" });
  }
});

test("confines every proposed file to the refresh write allowlist before publication", () => {
  const proposal = v.parse(
    stepSchema,
    steps.find(({ with: options }) => options?.mode === "refresh-pr"),
  );
  const confinement = commandStep("git status --porcelain");
  const paths = v.parse(v.string(), proposal.with?.paths).trim().split("\n");
  expect(paths).toHaveLength(4);
  expect(paths).toContain("packages/catalogue/entries/**/manifest.json");
  expect(paths).toContain(
    "packages/catalogue/upstream/pinned-content.gen.json",
  );
  expect(
    paths.filter(
      (path) =>
        path.startsWith("packages/catalogue/src/") && path.endsWith(".gen.ts"),
    ),
  ).toHaveLength(2);
  const excludedPaths = [
    ...v
      .parse(v.string(), confinement.run)
      .matchAll(/:\(exclude,(?:glob|literal)\)([^"\n]+)/gu),
  ].map((match) => match[1]);
  expect(excludedPaths.toSorted()).toEqual(paths.toSorted());
  for (const path of paths) {
    expect(confinement.run).toContain(
      `:(exclude,${path.includes("*") ? "glob" : "literal"})${path}`,
    );
  }
  expect(confinement.if).toBeUndefined();
  expect(confinement.run).toContain("::error::");
  expect(confinement.run).toContain("exit 1");
  expect(steps.indexOf(confinement)).toBeLessThan(steps.indexOf(proposal));
});

test("surfaces upstream failures after publication even when an earlier step fails", () => {
  const failures = commandStep(".failures[]");
  expect(failures.if).toContain("!cancelled()");
  expect(failures.if).toContain("steps.check.outputs.failure_count != '0'");
  expect(failures.run).toContain("::warning::");
  expect(failures.run).toContain("exit 1");
  for (const job of Object.values(workflow.jobs)) {
    const report = v.parse(v.string(), job.env?.UPSTREAM_REPORT);
    expect(report).toStartWith(["$", "{{ runner.temp }}/"].join(""));
    expect(report).toEndWith(".json");
    expect(report).not.toContain("$UPSTREAM_REPORT");
  }
  expect(steps.at(-1)).toBe(failures);
});
