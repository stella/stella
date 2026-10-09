import { expect, test } from "bun:test";
import path from "node:path";
import * as v from "valibot";

const root = path.resolve(import.meta.dir, "..");
const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  run: v.optional(v.string()),
  if: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.unknown())),
});
const workflowSchema = v.looseObject({
  on: v.looseObject({
    pull_request: v.optional(v.unknown()),
    push: v.optional(
      v.nullable(v.looseObject({ branches: v.array(v.string()) })),
    ),
    schedule: v.optional(
      v.nullable(v.array(v.looseObject({ cron: v.string() }))),
    ),
    workflow_dispatch: v.optional(
      v.nullable(
        v.looseObject({
          inputs: v.record(v.string(), v.looseObject({ type: v.string() })),
        }),
      ),
    ),
  }),
  jobs: v.record(v.string(), v.looseObject({ steps: v.array(stepSchema) })),
});
const readWorkflow = async (name: string) =>
  v.parse(
    workflowSchema,
    Bun.YAML.parse(
      await Bun.file(path.join(root, ".github/workflows", name)).text(),
    ),
  );
const auditWorkflow = await readWorkflow("dependency-audit.yml");
const releaseWorkflow = await readWorkflow("release-tag.yml");

const step = (
  workflow: v.InferOutput<typeof workflowSchema>,
  job: string,
  name: string,
) => {
  const found = workflow.jobs[job]?.steps.find(
    (candidate) => candidate.name === name,
  );
  expect(found, `missing ${name}`).toBeDefined();
  if (found === undefined) {
    throw new TypeError(`workflow step ${name} is missing`);
  }
  return found;
};

test("pull requests avoid network work when the lockfile is unchanged", () => {
  expect(auditWorkflow.on.pull_request).toBeNull();
  expect(step(auditWorkflow, "audit", "Detect lockfile changes").run).toContain(
    'git diff --quiet "$BASE_SHA...HEAD" -- bun.lock',
  );
  for (const name of ["Setup Bun", "Install dependencies"]) {
    expect(step(auditWorkflow, "audit", name).if).toContain(
      "steps.lockfile.outputs.changed == 'true'",
    );
  }
  expect(
    step(auditWorkflow, "audit", "Audit changed dependency resolutions").run,
  ).toContain("--check-diff");
});

test("full audits run on main and every six hours with one stable remediation identity", () => {
  expect(auditWorkflow.on.push?.branches).toEqual(["main"]);
  expect(auditWorkflow.on.schedule).toEqual([{ cron: "0 */6 * * *" }]);
  const remediation = step(auditWorkflow, "remediate", "Open one remediation");
  expect(remediation.env?.["FIX_BRANCH"]).toBe(
    "automation/dependency-audit-fix",
  );
  expect(remediation.run).toBe("bash scripts/remediate-dependency-audit.sh");
});

test("release audit blocks findings unless a reasoned explicit waiver is supplied", () => {
  const inputs = releaseWorkflow.on.workflow_dispatch?.inputs;
  expect(inputs?.["waive_dependency_audit"]?.type).toBe("boolean");
  expect(inputs?.["dependency_audit_waiver_reason"]?.type).toBe("string");
  const gate = step(
    releaseWorkflow,
    "tag",
    "Refuse a release with known dependency advisories",
  );
  expect(gate.run).toBe("bash scripts/check-release-dependency-audit.sh");
});
