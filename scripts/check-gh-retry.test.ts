import { expect, test } from "bun:test";
import path from "node:path";

import {
  GITHUB_COMMAND_OWNERS,
  githubCommandFiles,
  githubCommandProblems,
  rawGithubCommands,
} from "./check-gh-retry";

test("raw commands are detected across CI command forms", () => {
  for (const source of [
    "gh api repos/owner/repo",
    '"gh" api repos/owner/repo',
    "/usr/bin/gh api repos/owner/repo",
    'gh "$@"',
    "value=$(gh api repos/owner/repo)",
    'if gh release view "$TAG"; then :; fi',
    'GH_TOKEN="$token" gh run download 1',
    "bash scripts/retry.sh gh release upload v1 asset --clobber",
    "curl -fsSL https://api.github.com/repos/owner/repo",
  ]) {
    expect(rawGithubCommands("scripts/fixture.sh", source)).toEqual([1]);
  }
  for (const source of [
    'Bun.spawnSync(["gh", "api", endpoint]);',
    'Bun.spawnSync(["gh", ...args]);',
    'Bun.spawnSync({ cmd: ["gh", "api", endpoint] });',
    `execSync(\`gh api \${endpoint}\`);`,
    'execSync("gh run list");',
    'spawn("gh", ["api", endpoint]);',
    'execFileSync("gh", ["release", "view", tag]);',
    'spawn("/usr/bin/gh", ["api", endpoint]);',
  ]) {
    expect(rawGithubCommands("scripts/fixture.ts", source)).toEqual([1]);
  }
});

test("the reasoned command owner is the only exemption", () => {
  expect(Object.keys(GITHUB_COMMAND_OWNERS)).toEqual(["scripts/gh-retry.sh"]);
  expect(
    rawGithubCommands("scripts/gh-retry.sh", "gh api repos/owner/repo"),
  ).toEqual([]);
  expect(
    rawGithubCommands(
      "scripts/fixture.sh",
      '# gh api example\necho "gh run list"\nbash "$GH_RETRY_SCRIPT" api repos/owner/repo',
    ),
  ).toEqual([]);
  expect(
    rawGithubCommands(
      "scripts/fixture.ts",
      'Bun.spawnSync(["gh", "auth", "token"]);',
    ),
  ).toEqual([]);
});

test("literal language data is independent of process commands", () => {
  expect(
    rawGithubCommands("scripts/fixture.ts", 'const lexicon = [["gh", 7]];'),
  ).toEqual([]);
});

// These two tests read every CI script and workflow in the repository, which
// takes seconds on a shared runner: they carry their own budget instead of
// the 5 s default.
const REPOSITORY_SCAN_TIMEOUT_MS = 30_000;

test(
  "every CI script and workflow uses the command owner",
  () => {
    const root = path.resolve(import.meta.dir, "..");
    const files = githubCommandFiles(root);
    expect(files).toContain("scripts/merge-bar.ts");
    expect(files).toContain("packages/scripts/src/auth-md-spec-drift.ts");
    expect(files).toContain(".github/workflows/ci.yml");
    expect(files).toContain(".github/actions/promote-dispatch/action.yml");
    expect(githubCommandProblems(root)).toEqual([]);
  },
  REPOSITORY_SCAN_TIMEOUT_MS,
);

test(
  "workflow API tooling is pinned and survives source checkouts",
  async () => {
    const root = path.resolve(import.meta.dir, "..");
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    let consumers = 0;
    for (const file of githubCommandFiles(root).filter((candidate) =>
      candidate.startsWith(".github/workflows/"),
    )) {
      const parsed: unknown = Bun.YAML.parse(
        await Bun.file(path.join(root, file)).text(),
      );
      const jobs = record(parsed) ? parsed["jobs"] : undefined;
      expect(record(jobs), file).toBe(true);
      if (!record(jobs)) {
        continue;
      }
      for (const [name, definition] of Object.entries(jobs)) {
        if (!record(definition) || !Array.isArray(definition["steps"])) {
          continue;
        }
        const steps = definition["steps"].filter(record);
        const calls = steps
          .map((step, index) =>
            typeof step["run"] === "string" &&
            step["run"].includes('bash "$GH_RETRY_SCRIPT"')
              ? index
              : -1,
          )
          .filter((index) => index >= 0);
        if (calls.length === 0) {
          continue;
        }
        consumers += 1;
        const label = `${file}:${name}`;
        const env = definition["env"];
        expect(
          record(env) ? env["GH_RETRY_SCRIPT"] : undefined,
          label,
        ).toBeUndefined();
        const checkoutIndex = steps.findIndex((step) => {
          const settings = step["with"];
          return (
            record(settings) &&
            typeof settings["sparse-checkout"] === "string" &&
            settings["sparse-checkout"]
              .split("\n")
              .includes("scripts/gh-retry.sh")
          );
        });
        const checkout = steps.at(checkoutIndex);
        const settings = checkout?.["with"];
        expect(checkoutIndex, label).toBeGreaterThanOrEqual(0);
        expect(record(settings) ? settings["ref"] : undefined, label).toBe(
          `\${{ github.workflow_sha }}`,
        );
        expect(
          record(settings) ? settings["repository"] : undefined,
          label,
        ).toBe(`\${{ github.repository }}`);
        expect(
          record(settings) ? settings["persist-credentials"] : undefined,
          label,
        ).toBe(false);
        expect(
          record(settings) ? settings["sparse-checkout"] : undefined,
          label,
        ).toContain("scripts/gh-retry.sh");
        const toolingPath = record(settings) ? settings["path"] : undefined;
        if (typeof toolingPath !== "string") {
          throw new TypeError(`${label}: Missing tooling checkout path`);
        }
        const preserveIndex = steps.findIndex(
          (step) =>
            typeof step["run"] === "string" &&
            step["run"].trim() ===
              [
                `cp "$GITHUB_WORKSPACE/${toolingPath}/scripts/gh-retry.sh" "$RUNNER_TEMP/gh-retry.sh"`,
                'echo "GH_RETRY_SCRIPT=$RUNNER_TEMP/gh-retry.sh" >> "$GITHUB_ENV"',
              ].join("\n"),
        );
        expect(preserveIndex, label).toBeGreaterThan(checkoutIndex);
        for (const index of calls) {
          expect(preserveIndex, label).toBeLessThan(index);
        }
      }
    }
    expect(consumers).toBeGreaterThan(0);
  },
  REPOSITORY_SCAN_TIMEOUT_MS,
);

test.each([
  "echo ready; gh api repos/owner/repo",
  "printf x | gh api repos/owner/repo",
  "echo a && gh run view 1",
  "echo a || gh release view v1",
])("prose commands cannot hide subsequent GitHub commands: %s", (source) => {
  expect(rawGithubCommands("scripts/fixture.sh", source)).toEqual([1]);
});

test("quoted prose separators are not executable commands", () => {
  for (const source of [
    'echo "ready; gh api repos/owner/repo"',
    "printf '%s' 'x | gh api repos/owner/repo'",
    'echo "a && gh run view 1 || gh release view v1"',
    'echo "escaped \\" quote; gh api repos/owner/repo"',
  ]) {
    expect(rawGithubCommands("scripts/fixture.sh", source)).toEqual([]);
  }
});

test("command continuation retains physical diagnostic lines", () => {
  expect(
    rawGithubCommands(
      "scripts/fixture.sh",
      "echo ready \\\n  more\necho next; gh api \\\n  repos/owner/repo\ngh run view 1",
    ),
  ).toEqual([3, 5]);
});

test.each([
  "echo `gh api repos/owner/repo`",
  "printf '%s' `gh run view 1`",
  'echo "$(gh api repos/owner/repo)"',
  'printf "%s" "`gh release view v1`"',
])("checks executable prose substitutions: %s", (source) => {
  expect(rawGithubCommands("scripts/fixture.sh", source)).toEqual([1]);
});

test.each([
  "echo '$(gh api repos/owner/repo)'",
  "printf '%s' '`gh run view 1`'",
  'echo "\\$(gh api repos/owner/repo)"',
])("keeps quoted and escaped substitution prose literal: %s", (source) => {
  expect(rawGithubCommands("scripts/fixture.sh", source)).toEqual([]);
});

test("ANSI C quoted escaped prose cannot hide the following command", () => {
  expect(
    rawGithubCommands(
      "scripts/fixture.sh",
      "echo $'it\\'s ready'; gh api repos/owner/repo",
    ),
  ).toEqual([1]);
  expect(
    rawGithubCommands(
      "scripts/fixture.sh",
      "echo $'it\\'s ready; gh api repos/owner/repo'",
    ),
  ).toEqual([]);
});

test("nested prose substitutions distinguish printed text from execution", () => {
  expect(
    rawGithubCommands(
      "scripts/fixture.sh",
      `echo "$(printf '%s' 'gh api repos/owner/repo')"`,
    ),
  ).toEqual([]);
  expect(
    rawGithubCommands(
      "scripts/fixture.sh",
      `echo "$(printf '%s' "$(gh api repos/owner/repo)")"`,
    ),
  ).toEqual([1]);
});

test.each([
  `echo "$(printf x; gh api repos/owner/repo)"`,
  `echo "$(printf x | gh api repos/owner/repo)"`,
  `echo "$(printf x && gh run view 1)"`,
  `echo "$(printf x || gh release view v1)"`,
])("nested prose commands cannot hide subsequent execution: %s", (source) => {
  expect(rawGithubCommands("scripts/fixture.sh", source)).toEqual([1]);
});

test("nested quoted separators remain printf data", () => {
  expect(
    rawGithubCommands(
      "scripts/fixture.sh",
      `echo "$(printf '%s' 'x; gh api repos/owner/repo | gh run view 1 && gh release view v1 || gh api example')"`,
    ),
  ).toEqual([]);
});

test("nested ANSI C quoted prose retains its command boundary", () => {
  expect(
    rawGithubCommands(
      "scripts/fixture.sh",
      "echo \"$(printf $'it\\'s ready'; gh api example)\"",
    ),
  ).toEqual([1]);
  expect(
    rawGithubCommands(
      "scripts/fixture.sh",
      "echo \"$(printf $'it\\'s ready; gh api example')\"",
    ),
  ).toEqual([]);
});
