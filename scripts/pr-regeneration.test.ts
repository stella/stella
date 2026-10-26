import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertGeneratedTree,
  assertOutputPaths,
  assertRequiredServices,
  PR_GENERATORS,
  regenerationTarget,
  selectedGenerator,
} from "./pr-regeneration";
import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const sha = "a".repeat(40);
const repository = "example/repository";
const branch = "feature/regeneration";
const pull = {
  number: 123,
  state: "open",
  head: { ref: branch, sha, repo: { full_name: repository } },
  base: { repo: { full_name: repository, default_branch: "main" } },
};
const target = {
  pullRequest: pull,
  number: "123",
  repository,
  ref: `refs/heads/${branch}`,
  runSha: sha,
};

describe("regeneration target", () => {
  test("binds an open same-repository PR to its dispatch branch and exact head", () => {
    expect(regenerationTarget(target)).toEqual({ head: sha, branch });
  });
  test("refuses forks before source execution", () => {
    expect(() =>
      regenerationTarget({
        ...target,
        pullRequest: {
          ...pull,
          head: { ...pull.head, repo: { full_name: "example/fork" } },
        },
      }),
    ).toThrow("Fork pull requests are not eligible");
  });
  test("refuses a main-ref dispatch even when a PR number is supplied", () => {
    expect(() =>
      regenerationTarget({ ...target, ref: "refs/heads/main" }),
    ).toThrow("Dispatch must run on the pull request branch");
  });
  test("refuses a newer PR head and a closed PR", () => {
    expect(() =>
      regenerationTarget({ ...target, runSha: "b".repeat(40) }),
    ).toThrow("Pull request head changed");
    expect(() =>
      regenerationTarget({
        ...target,
        pullRequest: { ...pull, state: "closed" },
      }),
    ).toThrow("Expected an open pull request");
  });
  test("refuses malformed PR numbers", () => {
    expect(() => regenerationTarget({ ...target, number: "123/path" })).toThrow(
      "Invalid pull request number",
    );
  });
});

const fixture = () => {
  const root = mkdtempSync(path.join(tmpdir(), "pr-regeneration-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", root, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  git("init", "--quiet");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(path.join(root, "README.md"), "fixture\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "fixture");
  const head = git("rev-parse", "HEAD");
  const write = (file: string, content = "{}\n") => {
    const destination = path.join(root, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  };
  return {
    root,
    head,
    git,
    write,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

describe("generator output boundary", () => {
  test("registers only the supported generator IDs", () => {
    expect(Object.keys(PR_GENERATORS)).toEqual(["query-plan-contracts"]);
  });

  test("required services are checked against the actual job", () => {
    expect(() => assertRequiredServices([], null)).not.toThrow();
    expect(() =>
      assertRequiredServices(["postgres"], { postgres: { id: "fixture" } }),
    ).not.toThrow();
    expect(() => assertRequiredServices(["postgres"], {})).toThrow(
      "Generator requires unavailable services: postgres",
    );
  });
  test("unknown IDs cannot select a command", () => {
    for (const id of ["unregistered", "api-typecheck-projects"]) {
      expect(() => selectedGenerator(id)).toThrow(
        "Unknown regeneration generator",
      );
    }
  });
  for (const [id, definition] of Object.entries(PR_GENERATORS)) {
    test(`${id} admits exactly its registered output paths`, () => {
      expect(() => assertOutputPaths(id, definition.outputs)).not.toThrow();
      expect(() =>
        assertOutputPaths(id, [...definition.outputs, "README.md"]),
      ).toThrow("Changes outside generator outputs: README.md");
      const tree = fixture();
      try {
        for (const file of definition.outputs) {
          tree.write(file);
        }
        expect(
          assertGeneratedTree({
            root: tree.root,
            generator: id,
            head: tree.head,
          }).toSorted(),
        ).toEqual([...definition.outputs].toSorted());
      } finally {
        tree.cleanup();
      }
    });
  }
  test.each(["tracked", "staged", "staged-and-restored", "untracked"])(
    "refuses an undeclared %s change",
    (kind) => {
      const tree = fixture();
      try {
        const file = kind === "untracked" ? "unexpected.txt" : "README.md";
        tree.write(file, "changed\n");
        if (kind === "staged" || kind === "staged-and-restored") {
          tree.git("add", file);
        }
        if (kind === "staged-and-restored") {
          tree.write(file, "fixture\n");
        }
        expect(() =>
          assertGeneratedTree({
            root: tree.root,
            generator: "query-plan-contracts",
            head: tree.head,
          }),
        ).toThrow(`Changes outside generator outputs: ${file}`);
      } finally {
        tree.cleanup();
      }
    },
  );
  test("refuses a generated symlink and a generator-created commit", () => {
    const tree = fixture();
    const output = PR_GENERATORS["query-plan-contracts"].outputs[0];
    try {
      tree.write(output);
      rmSync(path.join(tree.root, output));
      symlinkSync(
        path.join(tree.root, "README.md"),
        path.join(tree.root, output),
      );
      expect(() =>
        assertGeneratedTree({
          root: tree.root,
          generator: "query-plan-contracts",
          head: tree.head,
        }),
      ).toThrow("Generated output must be a regular file");
      rmSync(path.join(tree.root, output));
      tree.write(output);
      tree.git("add", output);
      tree.git("commit", "--quiet", "-m", "fixture output");
      expect(() =>
        assertGeneratedTree({
          root: tree.root,
          generator: "query-plan-contracts",
          head: tree.head,
        }),
      ).toThrow("Generator moved the checked-out head");
    } finally {
      tree.cleanup();
    }
  });
});

test("manual regeneration uses the existing App only after target and output checks", () => {
  const source = readFileSync(
    new URL("../.github/workflows/autofix.yml", import.meta.url),
    "utf-8",
  );
  const workflow: unknown = Bun.YAML.parse(source);
  const steps = workflowJobSteps(workflow, "regenerate-requested-files");
  const request = workflowStepByName(steps, "Verify regeneration request");
  const checkout = workflowStepByName(steps, "Checkout regeneration head");
  const outputs = workflowStepByName(steps, "Verify generated outputs");
  const current = workflowStepByName(steps, "Verify current regeneration head");
  const push = workflowStepByName(steps, "Push regenerated files");
  expect(steps.indexOf(request)).toBeLessThan(steps.indexOf(checkout));
  expect(steps.indexOf(outputs)).toBeLessThan(steps.indexOf(current));
  expect(steps.indexOf(current)).toBeLessThan(steps.indexOf(push));
  const submission = workflowStepByName(
    steps,
    "Verify regeneration submission",
  );
  expect(steps.indexOf(push)).toBeLessThan(steps.indexOf(submission));
  expect(push).toHaveProperty("id", "regeneration-push");
  expect(push).toHaveProperty("continue-on-error", true);
  expect(submission).toHaveProperty(
    "if",
    `\${{ !cancelled() && steps.regeneration-push.outcome != 'skipped' }}`,
  );
  expect(submission).toHaveProperty("env", {
    SUBMISSION_OUTCOME: `\${{ steps.regeneration-push.outcome }}`,
    AUTOFIX_STARTED: `\${{ steps.regeneration-push.outputs.autofix_started }}`,
  });
  expect(current).toHaveProperty(
    "run",
    expect.stringContaining('check "$GENERATOR_ID" "$HEAD_SHA"'),
  );
  expect(
    steps.filter(
      (step) =>
        typeof step["uses"] === "string" &&
        step["uses"].startsWith("autofix-ci/action@"),
    ),
  ).toEqual([push]);
  expect(checkout).toHaveProperty(
    "with.ref",
    `\${{ steps.target.outputs.head }}`,
  );
  expect(checkout).toHaveProperty("with.persist-credentials", false);
  const tooling = workflowStepByName(steps, "Setup regeneration tooling");
  expect(tooling).toHaveProperty(
    "with.save",
    `\${{ github.ref == 'refs/heads/main' }}`,
  );
  const run = workflowStepByName(steps, "Run owning generator");
  expect(run).toHaveProperty(
    "env.JOB_SERVICES",
    `\${{ toJSON(job.services) }}`,
  );
  expect(run).not.toHaveProperty("env.STELLA_LOCAL_AUTOFIX");
  expect(push).toHaveProperty(
    "uses",
    "autofix-ci/action@c5b2d67aa2274e7b5a18224e8171550871fc7e4a",
  );
  expect(source).toContain(
    "format('dispatch-pr-{0}-run-{1}', inputs.pr, github.run_id)",
  );
  // Only the CI-requested changed-file autofix shares the per-PR group.
  expect(source).toContain(
    `cancel-in-progress: \${{ github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && inputs.generator == 'changed-files') }}`,
  );
  expect(source).not.toContain("contents: write");
  expect(source).not.toContain("secrets.");
  const raw = workflow;
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("jobs" in raw) ||
    typeof raw.jobs !== "object" ||
    raw.jobs === null ||
    !("regenerate-requested-files" in raw.jobs)
  ) {
    throw new TypeError("Missing regeneration job");
  }
  const job = raw.jobs["regenerate-requested-files"];
  expect(job).toHaveProperty(
    "if",
    "github.event_name == 'workflow_dispatch' && inputs.generator != 'changed-files'",
  );
  expect(job).toHaveProperty("permissions", {
    contents: "read",
    "pull-requests": "read",
  });
  if (typeof job !== "object" || job === null) {
    throw new TypeError("Expected regeneration job");
  }
  const services =
    "services" in job &&
    typeof job["services"] === "object" &&
    job["services"] !== null
      ? Object.keys(job["services"])
      : [];
  for (const generator of Object.values(PR_GENERATORS)) {
    expect(services).toEqual([...generator.services]);
  }
});

test("regeneration submission accepts started tasks and rejects unconfirmed failures", () => {
  const workflow: unknown = Bun.YAML.parse(
    readFileSync(
      new URL("../.github/workflows/autofix.yml", import.meta.url),
      "utf-8",
    ),
  );
  const submission = workflowStepByName(
    workflowJobSteps(workflow, "regenerate-requested-files"),
    "Verify regeneration submission",
  );
  const script = submission["run"];
  if (typeof script !== "string") {
    throw new TypeError("Missing regeneration submission script");
  }
  for (const [outcome, started, expected] of [
    ["success", "false", 0],
    ["success", "true", 0],
    ["failure", "true", 0],
    ["failure", "false", 1],
    ["failure", "", 1],
    ["cancelled", "true", 1],
    ["unknown", "true", 1],
  ] as const) {
    const result = Bun.spawnSync(["bash", "-c", script], {
      env: {
        ...process.env,
        SUBMISSION_OUTCOME: outcome,
        AUTOFIX_STARTED: started,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(expected);
  }
});
