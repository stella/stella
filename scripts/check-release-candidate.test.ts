import { panic } from "better-result";
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

import { evaluate } from "./github-expression";

const subject = readFileSync(
  new URL("check-release-candidate.sh", import.meta.url),
  "utf-8",
);
const schema = v.looseObject({
  on: v.looseObject({
    workflow_dispatch: v.object({ inputs: v.record(v.string(), v.unknown()) }),
  }),
  jobs: v.record(
    v.string(),
    v.looseObject({
      steps: v.optional(
        v.array(
          v.looseObject({
            name: v.string(),
            if: v.optional(v.string()),
            run: v.optional(v.string()),
            "continue-on-error": v.optional(v.union([v.boolean(), v.string()])),
            env: v.optional(v.record(v.string(), v.string())),
          }),
        ),
      ),
    }),
  ),
});
const workflows = [
  { name: "deploy-staging", job: "resolve" },
  { name: "main-heavy", job: "validate" },
].map(({ name, job }) => ({
  name,
  job,
  workflow: v.parse(
    schema,
    Bun.YAML.parse(
      readFileSync(
        new URL(`../.github/workflows/${name}.yml`, import.meta.url),
        "utf-8",
      ),
    ),
  ),
}));
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) {
    panic(result.stderr.toString());
  }
  return result.stdout.toString().trim();
};
const fixture = (script = subject) => {
  const directory = mkdtempSync(path.join(tmpdir(), "release-candidate-"));
  const repo = path.join(directory, "repo");
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  writeFileSync(path.join(repo, "scripts/check-release-candidate.sh"), script);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(repo, "VERSION"), "1.2.3\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "previous");
  const previous = git(repo, "rev-parse", "HEAD");
  writeFileSync(path.join(repo, "VERSION"), "1.2.4\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "pending");
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "update-ref", "refs/remotes/origin/main", sha);
  return { directory, repo, previous, sha };
};
const check = (repo: string, sha: string) =>
  Bun.spawnSync(["bash", "scripts/check-release-candidate.sh", sha], {
    cwd: repo,
  });
const assertIdentity = (script = subject) => {
  const { directory, repo, sha, previous } = fixture(script);
  try {
    const pending = check(repo, sha);
    expect(pending.exitCode, pending.stderr.toString()).toBe(0);
    expect(pending.stdout.toString()).toBe(
      `sha=${sha}\nvalue=1.2.4\ntag=v1.2.4\n`,
    );
    const mismatch = check(repo, previous);
    expect(mismatch.exitCode, "pending VERSION mismatch must fail").toBe(1);
    expect(mismatch.stderr.toString()).toContain(
      "does not match pending VERSION",
    );
    git(repo, "tag", "v1.2.4", sha);
    const tagged = check(repo, sha);
    expect(tagged.exitCode, "tagged VERSION must fail").toBe(1);
    expect(tagged.stderr.toString()).toContain(
      "Release tag v1.2.4 already exists",
    );
    expect(tagged.stdout.toString()).toBe("");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
const assertDispatch = (
  workflow: v.InferOutput<typeof schema>,
  job: string,
) => {
  const input = v.parse(
    v.object({ type: v.literal("boolean"), default: v.literal(false) }),
    workflow.on.workflow_dispatch.inputs["release_candidate"],
  );
  expect(input.default).toBe(false);
  const first =
    workflow.jobs[job]?.steps?.at(0) ??
    panic("Missing first release preflight");
  expect(first.name, "release preflight must run first").toBe(
    "Check release candidate",
  );
  expect(
    first["continue-on-error"] ?? false,
    "release preflight must stay blocking",
  ).toBe(false);
  expect(first.env?.["REQUESTED_SHA"]).toBe(`\${{ inputs.sha }}`);
  for (const event of ["workflow_dispatch", "push", "schedule"]) {
    for (const sha of ["", "a".repeat(40)]) {
      for (const flag of [false, true]) {
        const actual = evaluate(
          first.if ?? panic("Missing release opt-in condition"),
          {
            values: {
              "github.event_name": event,
              "inputs.sha": sha,
              "inputs.release_candidate": flag,
            },
          },
        );
        expect(actual, `${event}/${sha}/${String(flag)}`).toBe(
          event === "workflow_dispatch" && sha !== "" && flag,
        );
      }
    }
  }
  return first;
};

test("only untagged candidates matching the pending main VERSION pass before gate statuses exist", () =>
  assertIdentity());
test("removing tagged or pending VERSION refusals violates the candidate identity contract", () => {
  for (const [before, after, failure] of [
    [
      'git show-ref --verify --quiet "refs/tags/$tag"',
      "false",
      "tagged VERSION must fail",
    ],
    [
      '"$version" != "$main_version"',
      '"pending" != "pending"',
      "pending VERSION mismatch must fail",
    ],
  ]) {
    const mutant = subject.replace(
      before ?? panic("Missing mutation"),
      () => after ?? panic("Missing replacement"),
    );
    expect(mutant).not.toBe(subject);
    expect(() => assertIdentity(mutant)).toThrow(failure);
  }
});
test("both workflows check release candidates first only for explicit opt-in pinned dispatches", () => {
  const steps = workflows.map(({ workflow, job }) =>
    assertDispatch(workflow, job),
  );
  expect(steps.at(0)?.run).toBe(steps.at(1)?.run);
  for (const { workflow, job } of workflows) {
    for (const remove of [
      "github.event_name == 'workflow_dispatch' && ",
      "inputs.sha != '' && ",
      " && inputs.release_candidate == true",
    ]) {
      const mutant = structuredClone(workflow);
      const first =
        mutant.jobs[job]?.steps?.at(0) ?? panic("Missing mutation target");
      const original = first.if ?? panic("Missing condition");
      first.if = original.replace(remove, "");
      expect(first.if).not.toBe(original);
      expect(() => assertDispatch(mutant, job)).toThrow(
        /workflow_dispatch\/|push\//u,
      );
    }
    const reordered = structuredClone(workflow);
    reordered.jobs[job]?.steps?.reverse();
    expect(() => assertDispatch(reordered, job)).toThrow(
      "release preflight must run first",
    );
    const nonblocking = structuredClone(workflow);
    const first =
      nonblocking.jobs[job]?.steps?.at(0) ??
      panic("Missing preflight mutation");
    first["continue-on-error"] = true;
    expect(() => assertDispatch(nonblocking, job)).toThrow(
      "release preflight must stay blocking",
    );
  }
});
const assertBootstrap = (preflight: string) => {
  for (const tagged of [false, true]) {
    const { directory, repo, sha } = fixture();
    try {
      if (tagged) {
        git(repo, "tag", "v1.2.4", sha);
      }
      const server = path.join(directory, "server");
      mkdirSync(server);
      git(directory, "clone", "--bare", repo, path.join(server, "fixture.git"));
      const runner = path.join(directory, "runner");
      mkdirSync(runner);
      const result = Bun.spawnSync(["bash", "-c", preflight], {
        cwd: directory,
        env: {
          PATH: process.env["PATH"] ?? "",
          RUNNER_TEMP: runner,
          GH_TOKEN: "fixture",
          REPOSITORY: "fixture",
          SERVER_URL: server,
          REQUESTED_SHA: sha,
        },
      });
      expect(
        result.exitCode,
        tagged
          ? "tagged VERSION bootstrap must fail"
          : result.stderr.toString(),
      ).toBe(tagged ? 1 : 0);
      expect(result.stdout.toString()).toContain(
        tagged ? "::add-mask::" : `tag=v1.2.4`,
      );
      if (tagged) {
        expect(result.stderr.toString()).toContain("already exists");
      }
      expect(git(repo, "rev-parse", "HEAD")).toBe(sha);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
};
test("the actual first-step bootstrap fetches tags and uses the checker from main before candidate work", () => {
  const step = workflows.at(0) ?? panic("Missing staging workflow");
  const preflight =
    assertDispatch(step.workflow, step.job).run ??
    panic("Missing bootstrap script");
  assertBootstrap(preflight);
  const noTags = preflight.replace("fetch --tags", "fetch --no-tags");
  expect(noTags).not.toBe(preflight);
  expect(() => assertBootstrap(noTags)).toThrow(
    "tagged VERSION bootstrap must fail",
  );
});
test("tag preparation delegates the candidate identity checks to the same owner", () => {
  const prepare = readFileSync(
    new URL("prepare-release-tag.sh", import.meta.url),
    "utf-8",
  );
  expect(prepare).toContain(
    'candidate=$(bash "$script_dir/check-release-candidate.sh" "$sha")',
  );
  expect(prepare).not.toContain("git show-ref");
  expect(prepare).not.toContain("main_version=");
});
