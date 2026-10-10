import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const root = path.resolve(import.meta.dir, "..");
const stepSchema = v.looseObject({
  name: v.optional(v.string()),
  id: v.optional(v.string()),
  uses: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
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
  jobs: v.record(
    v.string(),
    v.looseObject({
      if: v.optional(v.string()),
      permissions: v.optional(v.record(v.string(), v.string())),
      concurrency: v.optional(
        v.object({ group: v.string(), "cancel-in-progress": v.boolean() }),
      ),
      steps: v.array(stepSchema),
    }),
  ),
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
const catalogWorkflow = await readWorkflow("model-catalog-check.yml");

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

// Runs the real detection step in a scratch repository whose HEAD changes
// only `changedPath` relative to its base commit.
const detectsDependencyChange = (changedPath: string) => {
  const repository = mkdtempSync(path.join(tmpdir(), "dependency-audit-"));
  // Git hooks export GIT_DIR; a child git must use the scratch repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: repository, env });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  try {
    git("init", "-q");
    for (const file of [
      "bun.lock",
      "package.json",
      "apps/api/package.json",
      "README.md",
    ]) {
      mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
      writeFileSync(path.join(repository, file), "base\n");
    }
    git("add", ".");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "base",
    );
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(repository, changedPath), "changed\n");
    git("add", ".");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "change",
    );
    const output = path.join(repository, "output");
    const run =
      step(auditWorkflow, "audit", "Detect lockfile changes").run ?? "";
    const result = Bun.spawnSync(["bash", "-e", "-c", run], {
      cwd: repository,
      env: { ...env, BASE_SHA: base, GITHUB_OUTPUT: output },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return readFileSync(output, "utf-8").trim();
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
};

test("pull requests avoid network work when the lockfile is unchanged", () => {
  expect(auditWorkflow.on.pull_request).toBeNull();
  for (const changed of ["bun.lock", "package.json", "apps/api/package.json"]) {
    expect(detectsDependencyChange(changed), changed).toBe("changed=true");
  }
  expect(detectsDependencyChange("README.md")).toBe("changed=false");
  for (const name of ["Setup Bun", "Install dependencies"]) {
    expect(step(auditWorkflow, "audit", name).if).toContain(
      "steps.lockfile.outputs.changed == 'true'",
    );
  }
  const pullRequestAudit = step(
    auditWorkflow,
    "audit",
    "Audit changed dependency resolutions",
  );
  expect(pullRequestAudit.if).toBe(
    "github.event_name == 'pull_request' && steps.lockfile.outputs.changed == 'true'",
  );
  expect(pullRequestAudit.run).toBe(
    'bun scripts/dependency-audit.ts --check-diff "$BASE_SHA"',
  );
});

test("full audits run on main and every six hours with one stable remediation identity", () => {
  expect(auditWorkflow.on.push?.branches).toEqual(["main"]);
  expect(auditWorkflow.on.schedule).toEqual([{ cron: "0 */6 * * *" }]);
  const remediation = step(auditWorkflow, "remediate", "Open one remediation");
  expect(auditWorkflow.jobs["remediate"]?.if).toBe(
    "always() && github.event_name != 'pull_request' && needs.audit.outputs.advisory_failure == 'true'",
  );
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

const githubExpression = (body: string) => `\${{ ${body} }}`;

test("remediation pushes and pull requests authenticate with a repository-scoped app token", () => {
  const token = step(auditWorkflow, "remediate", "Mint app token");
  const catalogToken = step(
    catalogWorkflow,
    "model-catalog-check",
    "Mint app token",
  );
  expect(token.id).toBe("app-token");
  expect(token.uses).toBe(catalogToken.uses);
  expect(token.with).toEqual(catalogToken.with);
  expect(token.with).toEqual({
    "app-id": githubExpression("secrets.PROVENANCE_APP_ID"),
    "private-key": githubExpression("secrets.PROVENANCE_APP_PRIVATE_KEY"),
    owner: githubExpression("github.repository_owner"),
    repositories: githubExpression("github.event.repository.name"),
    "permission-contents": "write",
    "permission-pull-requests": "write",
  });
  expect(auditWorkflow.jobs["remediate"]?.concurrency).toEqual({
    group: "dependency-audit-remediation",
    "cancel-in-progress": false,
  });
  expect(auditWorkflow.jobs["remediate"]?.permissions).toEqual({
    contents: "read",
  });
  expect(
    step(auditWorkflow, "remediate", "Checkout").with?.["persist-credentials"],
  ).toBe(false);
  const remediation = step(auditWorkflow, "remediate", "Open one remediation");
  expect(remediation.env?.["GH_TOKEN"]).toBe(
    githubExpression("steps.app-token.outputs.token"),
  );
  expect(remediation.env?.["GITHUB_TOKEN"]).toBeUndefined();
  expect(remediation.run).toBe("bash scripts/remediate-dependency-audit.sh");
});
