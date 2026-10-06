import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dir, "..");
const RESOLVER = path.join(ROOT, "scripts/resolve-staging-deploy-sha.sh");
const PREDICATE = path.join(ROOT, "scripts/staging-source-predicate.sh");
const SOURCE = `\${{ needs.resolve.outputs.sha }}`;
const MAIN = `\${{ needs.resolve.outputs.main-sha }}`;
const DIGEST = `\${{ steps.build.outputs.digest }}`;
const WORKFLOW_SHA = `\${{ github.workflow_sha }}`;
const STAGING_PREDICATE_TYPE =
  "https://github.com/stella/stella/attestations/staging-source/v1";

type RunOptions = {
  cwd: string;
  command: string[];
  env?: Record<string, string>;
};
const run = ({ cwd, command, env = {} }: RunOptions) => {
  const result = Bun.spawnSync(command, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      ...env,
    },
    timeout: 10_000,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString(),
  };
};
const git = (cwd: string, ...args: string[]) => {
  const result = run({
    cwd,
    command: [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
  });
  if (result.exitCode !== 0) {
    throw new TypeError(`Fixture Git operation failed: ${result.stderr}`);
  }
  return result.stdout;
};
const commit = (cwd: string, message: string) => {
  git(cwd, "commit", "--allow-empty", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
};
const withRepository = async (
  body: (fixture: {
    seed: string;
    checkout: string;
    base: string;
    old: string;
    side: string;
    other: string;
    tip: string;
  }) => void | Promise<void>,
  shallow = false,
) => {
  const workspace = mkdtempSync(path.join(tmpdir(), "staging-source-"));
  const seed = path.join(workspace, "seed");
  const checkout = path.join(workspace, "checkout");
  const remote = path.join(workspace, "remote.git");
  try {
    git(workspace, "init", "-q", "--initial-branch=main", seed);
    const base = commit(seed, "base");
    const old = commit(seed, "main source");
    git(seed, "switch", "-q", "-c", "side", base);
    const side = commit(seed, "side source");
    git(seed, "switch", "-q", "main");
    commit(seed, "main update");
    git(seed, "merge", "--no-ff", "-qm", "merge side", "side");
    const tip = git(seed, "rev-parse", "HEAD");
    git(seed, "switch", "-q", "-c", "other", base);
    const other = commit(seed, "other source");
    git(seed, "switch", "-q", "main");
    git(workspace, "clone", "-q", "--bare", seed, remote);
    git(seed, "remote", "add", "origin", remote);
    git(
      workspace,
      "clone",
      "-q",
      ...(shallow ? ["--depth=1"] : []),
      pathToFileURL(remote).href,
      checkout,
    );
    await body({ seed, checkout, base, old, side, other, tip });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
};
const resolve = (checkout: string, sha: string) =>
  run({ cwd: checkout, command: ["bash", RESOLVER, "--sha", sha] });
const outputs = (stdout: string) =>
  Object.fromEntries(stdout.split("\n").map((line) => line.split("=")));
type PredicateOptions = {
  checkout: string;
  sha: string;
  main: string;
  env?: Record<string, string>;
};
const predicate = ({ checkout, sha, main, env = {} }: PredicateOptions) =>
  run({
    cwd: checkout,
    command: ["bash", PREDICATE, "--sha", sha, "--main-sha", main],
    env: { GITHUB_REPOSITORY: "stella/stella", ...env },
  });
const expectRefused = (result: ReturnType<typeof run>) => {
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).toBe("");
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const record = (value: unknown) => {
  if (!isRecord(value)) {
    throw new TypeError("Workflow fixture must contain an object");
  }
  return value;
};
const steps = (scope: Record<string, unknown>) => {
  const value = scope["steps"];
  if (!Array.isArray(value)) {
    throw new TypeError("Workflow fixture must contain steps");
  }
  return value.map(record);
};
const document = (file: string) =>
  record(Bun.YAML.parse(readFileSync(path.join(ROOT, file), "utf-8")));

describe("staging source selection", () => {
  test("the tip and every older first-parent source share the fresh main anchor", async () => {
    await withRepository(({ checkout, tip }) => {
      for (const candidate of [
        "",
        ...git(checkout, "rev-list", "--first-parent", tip).split("\n"),
      ]) {
        const resolved = resolve(checkout, candidate);
        expect(resolved.exitCode).toBe(0);
        expect(outputs(resolved.stdout)).toEqual({
          sha: candidate || tip,
          tip: candidate === "" || candidate === tip ? "true" : "false",
          "main-sha": tip,
        });
      }
    });
  });

  test("merged second-parent sources and commits outside main are refused", async () => {
    await withRepository(({ checkout, side, other, tip }) => {
      expect(
        run({
          cwd: checkout,
          command: ["git", "merge-base", "--is-ancestor", side, tip],
        }).exitCode,
      ).toBe(0);
      expect(
        git(checkout, "rev-list", "--first-parent", tip).split("\n"),
      ).not.toContain(side);
      for (const candidate of [side, other]) {
        expectRefused(resolve(checkout, candidate));
      }
    });
  });

  test("selection refreshes main instead of retaining the checkout's tracking tip", async () => {
    await withRepository(({ seed, checkout, tip }) => {
      const updated = commit(seed, "new main source");
      git(seed, "push", "-q", "origin", "main");
      expect(git(checkout, "rev-parse", "origin/main")).toBe(tip);
      const resolved = resolve(checkout, "");
      expect(resolved.exitCode).toBe(0);
      expect(outputs(resolved.stdout)).toEqual({
        sha: updated,
        tip: "true",
        "main-sha": updated,
      });
    });
  });

  test("source selection uses only Git and Bash on a minimal runner path", async () => {
    await withRepository(({ checkout, old, tip }) => {
      const tools = path.join(checkout, "fixture-tools");
      mkdirSync(tools);
      for (const tool of ["git", "bash"]) {
        const executable = Bun.which(tool);
        if (!executable) {
          throw new TypeError(`Fixture requires ${tool}`);
        }
        symlinkSync(executable, path.join(tools, tool));
      }
      const resolved = run({
        cwd: checkout,
        command: ["bash", RESOLVER, "--sha", old],
        env: { PATH: tools },
      });
      expect(resolved.exitCode, resolved.stderr).toBe(0);
      expect(outputs(resolved.stdout)).toEqual({
        sha: old,
        tip: "false",
        "main-sha": tip,
      });
    });
  });

  test("a shallow checkout resolves older first-parent sources using full history", async () => {
    await withRepository(({ checkout, old, tip }) => {
      expect(git(checkout, "rev-parse", "--is-shallow-repository")).toBe(
        "true",
      );
      const resolved = resolve(checkout, old);
      expect(resolved.exitCode).toBe(0);
      expect(outputs(resolved.stdout)).toEqual({
        sha: old,
        tip: "false",
        "main-sha": tip,
      });
      expect(git(checkout, "rev-parse", "--is-shallow-repository")).toBe(
        "false",
      );
    }, true);
  });

  test("a rewritten remote main refuses cached sources removed from its history", async () => {
    await withRepository(({ seed, checkout, old, tip }) => {
      git(seed, "switch", "-q", "--orphan", "replacement");
      const replacement = commit(seed, "replacement main");
      git(seed, "push", "-q", "--force", "origin", "HEAD:main");
      expect(git(checkout, "cat-file", "-t", old)).toBe("commit");
      expectRefused(resolve(checkout, old));
      expectRefused(resolve(checkout, tip));
      expect(git(checkout, "rev-parse", "origin/main")).toBe(replacement);
    });
  });

  test("only full commit IDs can be explicitly selected", async () => {
    await withRepository(({ checkout, old }) => {
      for (const invalid of [
        old.slice(0, 12),
        "main",
        "origin/main",
        "f".repeat(40),
        "z".repeat(40),
      ]) {
        expectRefused(resolve(checkout, invalid));
      }
    });
  });
});

describe("staging source predicates", () => {
  test("the predicate records the checked-out source and supplied main anchor independently of the event SHA", async () => {
    await withRepository(({ checkout, old, tip, other }) => {
      git(checkout, "checkout", "-q", "--detach", old);
      const generated = predicate({
        checkout,
        sha: old,
        main: tip,
        env: { GITHUB_SHA: other },
      });
      expect(generated.exitCode).toBe(0);
      expect(JSON.parse(generated.stdout)).toEqual({
        repository: "https://github.com/stella/stella",
        commit: old,
        mainCommit: tip,
      });
      expect(old).not.toBe(other);
    });
  });

  test("a different checkout, malformed commit or repository cannot produce a predicate", async () => {
    await withRepository(({ checkout, old, tip }) => {
      expect(git(checkout, "rev-parse", "HEAD")).toBe(tip);
      expectRefused(
        predicate({ checkout, sha: old, main: tip, env: { GITHUB_SHA: old } }),
      );
      for (const invalid of ["", old.slice(0, 12), "main", "z".repeat(40)]) {
        expectRefused(predicate({ checkout, sha: invalid, main: tip }));
        expectRefused(predicate({ checkout, sha: tip, main: invalid }));
      }
      expectRefused(
        predicate({
          checkout,
          sha: tip,
          main: tip,
          env: { GITHUB_REPOSITORY: "other/project" },
        }),
      );
      expectRefused(
        predicate({
          checkout,
          sha: tip,
          main: tip,
          env: { GITHUB_REPOSITORY: "" },
        }),
      );
    });
  });

  test("the composite action generates its predicate from the source checkout using trusted tooling", async () => {
    await withRepository(async ({ checkout, old, tip, other }) => {
      git(checkout, "checkout", "-q", "--detach", old);
      const actionSteps = steps(
        record(document(".github/actions/provenance/action.yml")["runs"]),
      );
      const generated = actionSteps.find(
        (step) =>
          typeof step["run"] === "string" &&
          step["run"].includes("staging-source-predicate.sh"),
      );
      if (!generated || typeof generated["run"] !== "string") {
        throw new TypeError("Source predicate step must exist");
      }
      const output = path.join(checkout, "predicate-output");
      await Bun.write(output, "");
      const executed = run({
        cwd: checkout,
        command: ["bash", "-e", "-o", "pipefail", "-c", generated["run"]],
        env: {
          GITHUB_ACTION_PATH: path.join(ROOT, ".github/actions/provenance"),
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: "stella/stella",
          GITHUB_SHA: other,
          SOURCE_SHA: old,
          MAIN_SHA: tip,
        },
      });
      expect(executed.exitCode).toBe(0);
      const emitted = readFileSync(output, "utf-8").trim();
      expect(emitted.startsWith("predicate=")).toBe(true);
      expect(JSON.parse(emitted.slice("predicate=".length))).toEqual({
        repository: "https://github.com/stella/stella",
        commit: old,
        mainCommit: tip,
      });
      for (const [sourceSha, mainSha] of [
        [old, ""],
        ["", tip],
      ] as const) {
        const refused = run({
          cwd: checkout,
          command: ["bash", "-e", "-o", "pipefail", "-c", generated["run"]],
          env: {
            GITHUB_ACTION_PATH: path.join(ROOT, ".github/actions/provenance"),
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: "stella/stella",
            SOURCE_SHA: sourceSha,
            MAIN_SHA: mainSha,
          },
        });
        expectRefused(refused);
        expect(readFileSync(output, "utf-8").trim()).toBe(emitted);
      }
    });
  });
});

const assertImageBindings = (workflow: Record<string, unknown>) => {
  const jobs = record(workflow["jobs"]);
  const resolveJob = record(jobs["resolve"]);
  expect(record(resolveJob["outputs"])["main-sha"]).toBe(
    `\${{ steps.resolve.outputs.main-sha }}`,
  );
  const imageJobs = Object.entries(jobs).filter(([, job]) => {
    if (!isRecord(job) || !isRecord(job["outputs"])) {
      return false;
    }
    return typeof job["outputs"]["digest"] === "string";
  });
  expect(imageJobs.length).toBeGreaterThan(0);
  const promoted = steps(record(jobs["promote-staging"])).find(
    (step) => step["uses"] === "./.github/actions/promote-dispatch",
  );
  if (!promoted) {
    throw new TypeError("Staging promotion must exist");
  }
  const promotionInputs = record(promoted["with"]);
  expect(promotionInputs["git-sha"]).toBe(SOURCE);
  for (const [name, rawJob] of imageJobs) {
    const job = record(rawJob);
    const jobSteps = steps(job);
    const buildIndex = jobSteps.findIndex((step) => step["id"] === "build");
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    const build = jobSteps.at(buildIndex);
    if (!build) {
      throw new TypeError("Every image must have a build step");
    }
    const checkout = jobSteps
      .slice(0, buildIndex)
      .find(
        (step) =>
          typeof step["uses"] === "string" &&
          step["uses"].startsWith("actions/checkout@") &&
          record(step["with"])["ref"] === SOURCE,
      );
    expect(checkout).toBeDefined();
    const buildInputs = record(build["with"]);
    if (
      typeof build["uses"] === "string" &&
      build["uses"].startsWith("docker/build-push-action@")
    ) {
      expect(buildInputs["build-args"]).toContain(
        `STELLA_COMMIT_SHA=${SOURCE}`,
      );
    } else {
      expect(buildInputs["release-sha"]).toBe(SOURCE);
    }
    const trustedCheckout = jobSteps
      .slice(buildIndex + 1)
      .find(
        (step) =>
          typeof step["uses"] === "string" &&
          step["uses"].startsWith("actions/checkout@") &&
          record(step["with"])["path"] === ".workflow-actions",
      );
    if (!trustedCheckout) {
      throw new TypeError(
        "Attestation tooling must be checked out after the image build",
      );
    }
    const trustedInputs = record(trustedCheckout["with"]);
    expect(trustedInputs["ref"]).toBe(WORKFLOW_SHA);
    expect(trustedInputs["persist-credentials"]).toBe(false);
    expect(trustedInputs["sparse-checkout"]).toContain(
      ".github/actions/provenance",
    );
    expect(trustedInputs["sparse-checkout"]).toContain(
      "scripts/staging-source-predicate.sh",
    );
    const attestations = jobSteps.filter(
      (step) =>
        typeof step["uses"] === "string" &&
        step["uses"].endsWith("/.github/actions/provenance"),
    );
    expect(attestations).toHaveLength(1);
    for (const attestation of attestations) {
      expect(attestation["uses"]).toBe(
        "./.workflow-actions/.github/actions/provenance",
      );
      expect(jobSteps.indexOf(attestation)).toBeGreaterThan(
        jobSteps.indexOf(trustedCheckout),
      );
      const inputs = record(attestation["with"]);
      expect(inputs["subject-digest"]).toBe(DIGEST);
      expect(inputs["source-sha"]).toBe(SOURCE);
      expect(inputs["main-sha"]).toBe(MAIN);
    }
    expect(record(job["outputs"])["digest"]).toBe(DIGEST);
    expect(Object.values(promotionInputs)).toContain(
      `\${{ needs.${name}.outputs.digest }}`,
    );
  }
};

describe("staging image source bindings", () => {
  test("every staging image uses one source, anchor and digest through build, attestation and promotion", () => {
    assertImageBindings(document(".github/workflows/deploy-staging.yml"));
  });

  test("the image binding census detects changed source, anchor, digest and tooling inputs", () => {
    for (const [input, replacement, expected] of [
      ["source-sha", `\${{ github.sha }}`, SOURCE],
      ["main-sha", `\${{ github.sha }}`, MAIN],
      ["subject-digest", "sha256:other", DIGEST],
    ] as const) {
      const workflow = document(".github/workflows/deploy-staging.yml");
      const job = record(record(workflow["jobs"])["build-api"]);
      const attestation = steps(job).find(
        (step) =>
          step["uses"] === "./.workflow-actions/.github/actions/provenance",
      );
      if (!attestation) {
        throw new TypeError("Fixture attestation must exist");
      }
      record(attestation["with"])[input] = replacement;
      expect(() => assertImageBindings(workflow)).toThrow(expected);
    }
    const workflow = document(".github/workflows/deploy-staging.yml");
    const job = record(record(workflow["jobs"])["build-api"]);
    const checkout = steps(job).find(
      (step) =>
        isRecord(step["with"]) && step["with"]["path"] === ".workflow-actions",
    );
    if (!checkout) {
      throw new TypeError("Fixture tooling checkout must exist");
    }
    record(checkout["with"])["ref"] = SOURCE;
    expect(() => assertImageBindings(workflow)).toThrow(WORKFLOW_SHA);
  });

  test("ordinary and custom provenance attestations bind the same image digest", () => {
    const action = document(".github/actions/provenance/action.yml");
    const actionSteps = steps(record(action["runs"]));
    const attestations = actionSteps.filter(
      (step) =>
        typeof step["uses"] === "string" &&
        step["uses"].startsWith("actions/attest@"),
    );
    const custom = attestations.filter(
      (step) =>
        record(step["with"])["predicate-type"] === STAGING_PREDICATE_TYPE,
    );
    const ordinary = attestations.filter(
      (step) => record(step["with"])["predicate-type"] === undefined,
    );
    expect(custom.length).toBeGreaterThan(0);
    expect(ordinary.length).toBeGreaterThan(0);
    for (const attestation of attestations) {
      expect(attestation["uses"]).toMatch(/^actions\/attest@[a-f0-9]{40}$/u);
      const inputs = record(attestation["with"]);
      expect(inputs["subject-name"]).toBe(`\${{ inputs.subject-name }}`);
      expect(inputs["subject-digest"]).toBe(`\${{ inputs.subject-digest }}`);
      expect(inputs["push-to-registry"]).toBe(true);
    }
    const generated = actionSteps.find(
      (step) =>
        typeof step["run"] === "string" &&
        step["run"].includes("staging-source-predicate.sh"),
    );
    if (!generated) {
      throw new TypeError("Custom provenance must generate a source predicate");
    }
    const env = record(generated["env"]);
    expect(Object.values(env)).toContain(`\${{ inputs.source-sha }}`);
    expect(Object.values(env)).toContain(`\${{ inputs.main-sha }}`);
    expect(generated["run"]).toContain("GITHUB_ACTION_PATH");
    expect(generated["run"]).not.toContain("GITHUB_SHA");
    expect(generated["if"]).toBe(
      "inputs.source-sha != '' || inputs.main-sha != ''",
    );
    for (const attestation of custom) {
      expect(record(attestation["with"])["predicate"]).toBe(
        `\${{ steps.source.outputs.predicate }}`,
      );
    }
  });
});
