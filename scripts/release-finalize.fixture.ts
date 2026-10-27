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

const execute = (cwd: string, command: string[], env = process.env) =>
  Bun.spawnSync(command, { cwd, env });
const git = (cwd: string, ...args: string[]) => {
  const result = execute(cwd, ["git", ...args]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
};

type ProofFixture = {
  states?: Record<string, string>;
  runSha?: string;
  incidents?: boolean;
  noRc?: boolean;
  finalTag?: "candidate" | "previous";
  rcPublication?: "draft" | "published";
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
    for (const source of [
      "finalize-release.sh",
      "check-release-main-health.sh",
      "check-release-open-incidents.sh",
    ]) {
      cpSync(new URL(source, import.meta.url), path.join(root, source));
    }
    writeFileSync(
      path.join(root, "verifier.sh"),
      "#!/usr/bin/env bash\nexit 0\n",
    );
    const contexts = [
      ["staging/verified", "deploy-staging.yml", "Staging release proof "],
      ["main/heavy", "main-heavy.yml", "Main heavy suites "],
      ["main/pr-depth", "main-pr-depth.yml", "Main PR-depth checks "],
    ];
    const statuses = contexts
      .map(([context], index) => ({
        context,
        state: fixture.states?.[context ?? ""] ?? "success",
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
  'release edit '*) [[ "$GH_TOKEN" == fixture-token ]] ;;
  *) [[ "$GH_TOKEN" == fixture-read-token ]] ;;
esac
case "$*" in
  'release view '*) printf '%s\\n' '${fixture.rcPublication !== "published"}' ;;
  *statuses?*) cat "$TEST_ROOT/statuses.json" ;;
  *actions/runs/*) run="\u0024{!#}"; cat "$TEST_ROOT/run-\u0024{run##*/}.json" ;;
  *issues?*) cat "$TEST_ROOT/incidents.json" ;;
  'release edit '*) printf '%s\\n' "$*" >> "$TEST_ROOT/publications" ;;
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
    const result = execute(
      root,
      ["bash", "finalize-release.sh", "stella/stella", sha],
      {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_ROOT: root,
        GH_TOKEN: "fixture-token",
        RELEASE_HEALTH_TOKEN: "fixture-read-token",
        GH_RETRY_SCRIPT: path.join(root, "gh.sh"),
        RELEASE_TREE_PROOF_VERIFIER: path.join(root, "verifier.sh"),
      },
    );
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
