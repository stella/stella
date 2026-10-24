import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";
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

import { drawPropertySamples } from "@stll/property-testing";

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
  for (const name of ["verify-release-tree-proof.sh", "gh-retry.sh"]) {
    writeFileSync(
      path.join(repo, "scripts", name),
      readFileSync(new URL(name, import.meta.url), "utf-8"),
    );
  }
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "tag.gpgsign", "false");
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
    git(repo, "commit", "--allow-empty", "-qm", "later");
    const later = git(repo, "rev-parse", "HEAD");
    git(repo, "update-ref", "refs/remotes/origin/main", later);
    const unrelated = check(repo, later);
    expect(unrelated.exitCode, "later main commit must fail").toBe(1);
    expect(unrelated.stderr.toString()).toContain(`version commit ${sha}`);
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
test("removing tagged or version commit refusals violates the candidate identity contract", () => {
  for (const [before, after, failure] of [
    [
      'git show-ref --verify --quiet "refs/tags/$tag"',
      "false",
      "tagged VERSION must fail",
    ],
    [
      '"$sha" != "$version_commit"',
      '"pending" != "pending"',
      "later main commit must fail",
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
}, 20_000);
test("tag preparation delegates the candidate identity checks to the same owner", () => {
  const prepare = readFileSync(
    new URL("prepare-release-tag.sh", import.meta.url),
    "utf-8",
  );
  expect(prepare).toContain(
    'candidate=$(RELEASE_PROOF_REPOSITORY= bash "$script_dir/check-release-candidate.sh" "$sha")',
  );
  expect(prepare).not.toContain("git show-ref");
  expect(prepare).not.toContain("main_version=");
});

const historyEdits = fc.array(
  fc.record({
    version: fc.option(fc.integer({ min: 0, max: 6 }), { nil: undefined }),
    content: fc.nat(),
  }),
  { minLength: 1, maxLength: 6 },
);
// Measured p95: 17.2 s; this must spawn release checks across real Git histories.
test("only the version commit is accepted across generated main histories", () => {
  // Each sample spawns the release scripts, so the histories are drawn once
  // and run as a batch rather than inside a property predicate.
  for (const { value: edits, label } of drawPropertySamples(historyEdits, {
    numRuns: 12,
  })) {
    const { directory, repo, sha, previous } = fixture();
    try {
      writeFileSync(
        path.join(repo, "scripts/prepare-release-tag.sh"),
        readFileSync(
          new URL("prepare-release-tag.sh", import.meta.url),
          "utf-8",
        ),
      );
      for (const name of [
        "verify-release-tree-proof.sh",
        "check-release-main-health.sh",
      ]) {
        writeFileSync(
          path.join(repo, "scripts", name),
          "#!/bin/bash\nexit 0\n",
        );
      }
      writeFileSync(
        path.join(repo, "scripts/gh-retry.sh"),
        `#!/bin/bash
printf '%s\\n' '[[{"context":"staging/verified","state":"success"},{"context":"main/heavy","state":"success"},{"context":"main/pr-depth","state":"success"}]]'
`,
      );
      const commits = [previous, sha];
      let version = "1.2.4";
      let versionCommit = sha;
      // Always include a later unchanged VERSION commit, even after shrinking.
      for (const edit of [...edits, { version: undefined, content: 0 }]) {
        const nextVersion =
          edit.version === undefined ? version : `1.2.${edit.version}`;
        writeFileSync(path.join(repo, "VERSION"), `${nextVersion}\n`);
        writeFileSync(path.join(repo, "content"), String(edit.content));
        git(repo, "add", ".");
        git(repo, "commit", "--allow-empty", "-qm", "history edit");
        const commit = git(repo, "rev-parse", "HEAD");
        commits.push(commit);
        if (nextVersion !== version) {
          versionCommit = commit;
        }
        version = nextVersion;
      }
      git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      for (const commit of commits) {
        const candidate = check(repo, commit);
        const prepared = Bun.spawnSync(
          [
            "bash",
            "scripts/prepare-release-tag.sh",
            "--repo",
            "stella/stella",
            "--sha",
            commit,
          ],
          { cwd: repo },
        );
        for (const result of [candidate, prepared]) {
          expect(
            result.exitCode,
            `${label} identity ${commit}: ${result.stderr.toString()}`,
          ).toBe(commit === versionCommit ? 0 : 1);
          if (commit === versionCommit) {
            expect(result.stdout.toString()).toContain(
              `sha=${versionCommit}\n`,
            );
          } else {
            expect(result.stdout.toString()).toBe("");
            expect(result.stderr.toString()).toContain(versionCommit);
          }
        }
      }
      const selected = Bun.spawnSync(
        ["bash", "scripts/prepare-release-tag.sh", "--repo", "stella/stella"],
        { cwd: repo },
      );
      expect(selected.exitCode, `${label} ${selected.stderr.toString()}`).toBe(
        0,
      );
      expect(selected.stdout.toString()).toContain(`sha=${versionCommit}\n`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}, 35_000);

test("an unmerged release pull request head passes only through the trusted PR-head verifier", () => {
  const { directory, repo } = fixture();
  try {
    git(repo, "switch", "-q", "-c", "release");
    writeFileSync(path.join(repo, "VERSION"), "1.2.5\n");
    git(repo, "add", "VERSION");
    git(repo, "commit", "-qm", "chore: release v1.2.5");
    const head = git(repo, "rev-parse", "HEAD");
    const calls = path.join(directory, "verifier-calls");
    const verifier = path.join(directory, "verifier.sh");
    writeFileSync(
      verifier,
      `printf '%s\\n' "$*" >> "${calls}"\nexit "\${VERIFIER_EXIT:?}"\n`,
    );
    const run = (verifierExit: string, proofRepository = "stella/stella") =>
      Bun.spawnSync(["bash", "scripts/check-release-candidate.sh", head], {
        cwd: repo,
        env: {
          ...process.env,
          RELEASE_PROOF_REPOSITORY: proofRepository,
          RELEASE_TREE_PROOF_VERIFIER: verifier,
          VERIFIER_EXIT: verifierExit,
        },
      });

    const accepted = run("0");
    expect(accepted.exitCode, accepted.stderr.toString()).toBe(0);
    expect(accepted.stdout.toString()).toBe(
      `sha=${head}\nvalue=1.2.5\ntag=v1.2.5\n`,
    );
    expect(readFileSync(calls, "utf-8")).toBe(
      `--allow-pr-head stella/stella ${head} ${head}\n`,
    );

    const refused = run("1");
    expect(refused.exitCode, "a head the verifier refuses must fail").not.toBe(
      0,
    );
    expect(refused.stdout.toString()).toBe("");

    const untrusted = run("0", "");
    expect(untrusted.exitCode, "no trusted verifier, no PR head").toBe(1);
    expect(untrusted.stderr.toString()).toContain(
      "is not an ancestor of origin/main",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
