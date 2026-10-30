import { expect } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

const execute = (cwd: string, command: string[], env = process.env) =>
  Bun.spawnSync(command, { cwd, env });
const git = (cwd: string, ...args: string[]) => {
  const result = execute(cwd, ["git", ...args]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};

const readFinalizationCommand = () => {
  const workflow = v.parse(
    v.looseObject({
      jobs: v.looseObject({
        finalize: v.looseObject({
          steps: v.array(
            v.looseObject({
              id: v.optional(v.string()),
              run: v.optional(v.string()),
            }),
          ),
        }),
      }),
    }),
    Bun.YAML.parse(
      readFileSync(
        new URL("../.github/workflows/release-tag.yml", import.meta.url),
        "utf-8",
      ),
    ),
  );
  return v.parse(
    v.string(),
    workflow.jobs.finalize.steps.find(({ id }) => id === "finalize")?.run,
  );
};

type ProofFixture = {
  states?: Record<string, string>;
  runSha?: string;
  incidents?: boolean;
  noRc?: boolean;
  finalTag?: "candidate" | "previous";
  rcPublication?: "draft" | "published";
  publicationFails?: boolean;
  pull?:
    | "matching"
    | "none"
    | "multiple"
    | "mismatch"
    | "merged"
    | "armed"
    | "queued"
    | "fork"
    | "fork-alongside"
    | "closed";
  mergeFails?: boolean;
};
const pullState = (pull: ProofFixture["pull"]) => {
  if (pull === "merged") {
    return "MERGED";
  }
  return pull === "closed" ? "CLOSED" : "OPEN";
};

export const finalize = (fixture: ProofFixture = {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "release-finalize-"));
  try {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    git(root, "init", "-q", "--template=");
    git(root, "config", "user.name", "Release fixture");
    git(root, "config", "user.email", "fixture@example.test");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "config", "tag.gpgsign", "false");
    writeFileSync(path.join(root, "VERSION"), "1.2.2\n");
    git(root, "add", "VERSION");
    git(root, "commit", "-qm", "previous release");
    writeFileSync(path.join(root, "VERSION"), "1.2.3\n");
    git(root, "add", "VERSION");
    git(root, "commit", "-qm", "release candidate");
    const sha = git(root, "rev-parse", "HEAD");
    if (!fixture.noRc) {
      git(root, "tag", "v1.2.3-rc.2", sha);
    }
    if (fixture.finalTag) {
      git(
        root,
        "tag",
        "v1.2.3",
        fixture.finalTag === "candidate" ? sha : `${sha}^`,
      );
    }
    cpSync(
      new URL("land-release-pr.sh", import.meta.url),
      path.join(root, "land-release-pr.sh"),
    );
    writeFileSync(
      path.join(root, "verifier.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    const pull = {
      number: 123,
      title: "chore: release v1.2.3",
      state: pullState(fixture.pull),
      headRefName: "release/v1.2.3",
      headRefOid: fixture.pull === "mismatch" ? "f".repeat(40) : sha,
      isCrossRepository: fixture.pull === "fork",
      isInMergeQueue: fixture.pull === "queued",
      autoMergeRequest:
        fixture.pull === "armed" ? { enabledAt: "2026-01-01T00:00:00Z" } : null,
    };
    const pulls = fixture.pull === "none" ? [] : [pull];
    if (fixture.pull === "multiple") {
      pulls.push({ ...pull, number: 456 });
    }
    if (fixture.pull === "fork-alongside") {
      pulls.unshift({ ...pull, number: 456, isCrossRepository: true });
    }
    writeFileSync(
      path.join(root, "pulls.json"),
      JSON.stringify({ nodes: pulls, pageInfo: { hasNextPage: false } }),
    );
    const contexts = [
      [
        "staging/verified",
        "deploy-staging.yml",
        "Staging release proof v1.2.3-rc.2 ",
      ],
      ["main/heavy", "main-heavy.yml", "Main heavy suites "],
      ["main/pr-depth", "main-pr-depth.yml", "Main PR-depth checks "],
    ] as const;
    const statuses = contexts
      .map(([context], index) => ({
        context,
        state: fixture.states?.[context] ?? "success",
        creator: { login: "github-actions[bot]", type: "Bot" },
        target_url: `https://github.com/stella/stella/actions/runs/${index + 1}`,
      }))
      .filter(({ state }) => state !== "missing");
    writeFileSync(path.join(root, "statuses.json"), JSON.stringify([statuses]));
    for (const [index, [, workflow, title]] of contexts.entries()) {
      writeFileSync(
        path.join(root, `run-${index + 1}.json`),
        JSON.stringify({
          id: index + 1,
          html_url: `https://github.com/stella/stella/actions/runs/${index + 1}`,
          repository: { full_name: "stella/stella" },
          path: `.github/workflows/${workflow}`,
          head_branch: "main",
          event: "workflow_dispatch",
          display_title: `${title}${fixture.runSha ?? sha}`,
          status: "completed",
          conclusion: "success",
        }),
      );
    }
    writeFileSync(
      path.join(root, "incidents.json"),
      JSON.stringify([fixture.incidents ? [{ id: 1 }] : []]),
    );
    writeFileSync(
      path.join(root, "gh.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  # A draft release is visible only to a token with push access.
  'api graphql '*|'pr '*) [[ "$GH_TOKEN" == fixture-landing-token ]] ;;
  'release '*) [[ "$GH_TOKEN" == fixture-token ]] ;;
  *) [[ "$GH_TOKEN" == fixture-read-token ]] ;;
esac
case "$*" in
  'api graphql '*) cat "$TEST_ROOT/pulls.json" ;;
  'pr merge '*)
    ${fixture.mergeFails || fixture.pull === "queued" ? 'echo "merge failed" >&2; exit 1' : 'printf \'%s\\n\' "$*" >> "$TEST_ROOT/merges"'} ;;
  'release view '*) printf '%s\\n' '${fixture.rcPublication !== "published"}' ;;
  *statuses?*) cat "$TEST_ROOT/statuses.json" ;;
  *actions/runs/*) run="\u0024{!#}"; cat "$TEST_ROOT/run-\u0024{run##*/}.json" ;;
  *issues?*) cat "$TEST_ROOT/incidents.json" ;;
  'release edit '*)
    ${fixture.publicationFails === true ? 'echo "release edit failed" >&2; exit 1' : 'printf \'%s\\n\' "$*" >> "$TEST_ROOT/publications"'} ;;
  *) echo "Unexpected API request $*" >&2; exit 1 ;;
esac
`,
    );
    const realGit = execute(root, ["which", "git"]).stdout.toString().trim();
    writeFileSync(
      path.join(bin, "git"),
      `#!/usr/bin/env bash
if [[ "$1" == push ]]; then
  printf '%s\\n' "$*" >> "$TEST_ROOT/pushes"
  exit 0
fi
exec "${realGit}" "$@"
`,
      { mode: 0o755 },
    );
    mkdirSync(path.join(root, "scripts"));
    // The workflow runs trusted tooling from scripts/.
    for (const source of [
      "finalize-release.sh",
      "check-release-main-health.sh",
      "check-release-open-incidents.sh",
    ]) {
      cpSync(
        new URL(source, import.meta.url),
        path.join(root, "scripts", source),
      );
    }
    const outputFile = path.join(root, "step-output");
    const result = execute(
      root,
      ["bash", "-euo", "pipefail", "-c", readFinalizationCommand()],
      {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
        TEST_ROOT: root,
        GITHUB_REPOSITORY: "stella/stella",
        RELEASE_SHA: sha,
        GITHUB_OUTPUT: outputFile,
        GH_TOKEN: "fixture-token",
        RELEASE_HEALTH_TOKEN: "fixture-read-token",
        GH_RETRY_SCRIPT: path.join(root, "gh.sh"),
        RELEASE_TREE_PROOF_VERIFIER: path.join(root, "verifier.sh"),
      },
    );
    const stepOutput =
      Bun.file(outputFile).size > 0 ? readFileSync(outputFile, "utf-8") : "";
    const landing =
      result.exitCode === 0 && stepOutput.startsWith("final_tag=")
        ? execute(root, ["bash", "land-release-pr.sh", "stella/stella", sha], {
            ...process.env,
            GH_TOKEN: "fixture-landing-token",
            TEST_ROOT: root,
            GH_RETRY_SCRIPT: path.join(root, "gh.sh"),
          })
        : null;
    const finalTag = execute(root, [
      realGit,
      "rev-parse",
      "--verify",
      "refs/tags/v1.2.3^{commit}",
    ]);
    const readReceipt = (name: string) => {
      const file = Bun.file(path.join(root, name));
      return file.size > 0 ? readFileSync(path.join(root, name), "utf-8") : "";
    };
    return {
      result,
      stepOutput,
      landing,
      merges: readReceipt("merges"),
      sha,
      finalSha:
        finalTag.exitCode === 0 ? finalTag.stdout.toString().trim() : null,
      pushes: readReceipt("pushes"),
      publications: readReceipt("publications"),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
