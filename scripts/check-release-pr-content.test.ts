import { expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  checkReleaseMergeGroup,
  checkReleasePullRequest,
  validateReleaseContent,
} from "./check-release-pr-content";

const ROOT = path.resolve(import.meta.dir, "..");
const check = (before: Record<string, string>, after: Record<string, string>) =>
  validateReleaseContent({
    files: [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((filename) => before[filename] !== after[filename])
      .map((filename) => {
        if (!(filename in after)) {
          return { filename, status: "removed" };
        }
        if (!(filename in before)) {
          return { filename, status: "added" };
        }
        return { filename, status: "modified" };
      }),
    read: (side, filename) =>
      (side === "base" ? before : after)[filename] ?? "",
  });
const run = (cwd: string, args: readonly string[]) => {
  const result = Bun.spawnSync([...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_TOKEN: "", GITHUB_TOKEN: "" },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
};

test("every tracked source and configuration path stays outside release output", () => {
  const tracked = run(ROOT, ["git", "ls-files", "-z"])
    .split("\0")
    .filter(Boolean);
  const candidates = tracked.filter(
    (filename) =>
      !/^(?:(?:(?:apps|packages)\/[^/]+\/)?(?:package\.json|CHANGELOG\.md)|docs\/changelog\/[^/]+\.md|VERSION|bun\.lock|packages\/cli\/src\/generated\/cli-version\.ts|apps\/landing\/src\/data\/changelog-release-dates\.json)$/u.test(
        filename,
      ),
  );
  expect(candidates).toContain("scripts/release-pull-requests.sh");
  for (const filename of candidates) {
    expect(() => check({ [filename]: "old" }, { [filename]: "new" })).toThrow(
      filename,
    );
  }
  for (const filename of [
    ".changeset/new.md",
    ".changeset/README.md",
    ".github/workflows/new.yml",
    "packages/new/package.json",
    "docs/changelog/nested/code.ts",
  ]) {
    expect(() => check({}, { [filename]: "{}" })).toThrow(filename);
  }
  check({ ".changeset/consumed.md": '---\n"@stll/cli": patch\n---\n' }, {});
});

test("release package edits cannot change scripts, dependency identities, or remove version fields", () => {
  const filename = "packages/cli/package.json";
  const manifest = {
    name: "@stll/cli",
    version: "1.0.0",
    scripts: { build: "safe" },
    dependencies: { external: "^1.0.0" },
  };
  const before = { [filename]: JSON.stringify(manifest) };
  for (const after of [
    { ...manifest, version: "1.0.1", scripts: { build: "unsafe" } },
    { ...manifest, version: "1.0.1", dependencies: { external: "^1.0.1" } },
    { name: "@stll/cli", scripts: { build: "safe" } },
  ]) {
    expect(() => check(before, { [filename]: JSON.stringify(after) })).toThrow(
      filename,
    );
  }
});

test("immutable release blobs use the merge base, batch reads, and reject races or missing data", () => {
  const files = Array.from({ length: 25 }, (_, index) => ({
    filename: `packages/fixture${index}/package.json`,
    status: "modified",
  }));
  const sizes: number[] = [];
  let metadataCalls = 0;
  let race = false;
  let missing = false;
  let partial = false;
  const api = (endpoint: string, options: readonly string[] = []): unknown => {
    if (endpoint === "repos/stella/stella/pulls/12") {
      metadataCalls++;
      return {
        draft: false,
        title: "chore: release v1.2.3",
        changed_files: files.length,
        base: { sha: "base-tip", ref: "main" },
        head: {
          sha: race && metadataCalls > 1 ? "changed" : "head",
          repo: { full_name: "stella/stella" },
        },
      };
    }
    if (endpoint === "repos/stella/stella/compare/base-tip...head") {
      return { merge_base_commit: { sha: "merge-base" } };
    }
    if (endpoint.includes("/files?")) {
      return [partial ? files.slice(1) : files];
    }
    expect(endpoint).toBe("graphql");
    if (missing) {
      return { errors: [{ message: "unavailable" }] };
    }
    const query = options.at(1) ?? "";
    const blobs: Record<string, { text: string }> = {};
    const matches = [
      ...query.matchAll(/blob(\d+): object\(expression: ("[^"\n]+")\)/gu),
    ];
    sizes.push(matches.length);
    for (const match of matches) {
      const expression = String(JSON.parse(match.at(2) ?? '""'));
      expect(expression).toMatch(/^(?:merge-base|head):/u);
      blobs[`blob${String(match.at(1))}`] = {
        text: JSON.stringify({
          name: expression.split(":").at(1),
          version: expression.startsWith("merge-base:") ? "1.0.0" : "1.0.1",
        }),
      };
    }
    return { data: { repository: blobs } };
  };
  checkReleasePullRequest({ repo: "stella/stella", number: 12, api });
  expect(sizes).toEqual([40, 10]);
  race = true;
  metadataCalls = 0;
  expect(() =>
    checkReleasePullRequest({ repo: "stella/stella", number: 12, api }),
  ).toThrow("changed during content validation");
  race = false;
  missing = true;
  expect(() =>
    checkReleasePullRequest({ repo: "stella/stella", number: 12, api }),
  ).toThrow("failed to read immutable");
  missing = false;
  partial = true;
  expect(() =>
    checkReleasePullRequest({ repo: "stella/stella", number: 12, api }),
  ).toThrow("incomplete release file listing");
});

test("squashed queue commits check every included release and the release entry", () => {
  const checked: string[] = [];
  const group = {
    base_sha: "base",
    head_sha: "head",
    head_ref: "refs/heads/gh-readonly-queue/main/pr-12-abcdef",
  };
  let truncated = false;
  const api = (endpoint: string): unknown => {
    if (endpoint === "repos/stella/stella/compare/base...head") {
      return {
        total_commits: truncated ? 2 : 1,
        commits: [{ sha: "squashed" }],
      };
    }
    if (
      endpoint === "repos/stella/stella/commits/squashed/pulls?per_page=100"
    ) {
      return [[{ number: 11 }, { number: 99 }]];
    }
    if (endpoint.includes("/compare/")) {
      return { merge_base_commit: { sha: "merge-base" } };
    }
    if (endpoint.includes("/files?")) {
      return [[]];
    }
    const number = Number(endpoint.split("/").at(-1));
    checked.push(String(number));
    return {
      draft: false,
      title: "chore: release v1.2.3",
      changed_files: 0,
      base: { sha: "main", ref: "main" },
      head: { sha: `release-${number}`, repo: { full_name: "stella/stella" } },
    };
  };
  checkReleaseMergeGroup({
    repo: "stella/stella",
    group,
    numbers: [10, 11, 12],
    api,
  });
  // Each checked release is read before and after validation; unrelated entries
  // and recognized releases outside this group never reach the content boundary.
  expect(checked).toEqual(["11", "11", "12", "12"]);
  truncated = true;
  expect(() =>
    checkReleaseMergeGroup({
      repo: "stella/stella",
      group,
      numbers: [11],
      api,
    }),
  ).toThrow("incomplete merge group commit listing");
  checkReleaseMergeGroup({
    repo: "stella/stella",
    group,
    numbers: [],
    api: () => {
      throw new Error("unexpected API call without a release");
    },
  });
});

test("the real versioning command produces only permitted generated deltas", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-release-output-"));
  try {
    const tracked = run(ROOT, ["git", "ls-files", "-z"]).split("\0");
    const inputs = [
      "package.json",
      "bun.lock",
      ".changeset/config.json",
      "scripts/sync-lockfile-workspace-versions.ts",
      "scripts/lockfile-workspace-versions.ts",
      "scripts/json-text-edit.ts",
      "packages/cli/src/codegen-version.ts",
      "packages/cli/src/generated/cli-version.ts",
      ...tracked.filter((filename) =>
        /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(filename),
      ),
    ];
    for (const filename of inputs) {
      mkdirSync(path.dirname(path.join(directory, filename)), {
        recursive: true,
      });
      cpSync(path.join(ROOT, filename), path.join(directory, filename));
    }
    symlinkSync(
      path.join(ROOT, "node_modules"),
      path.join(directory, "node_modules"),
      "dir",
    );
    run(directory, ["git", "init", "-q"]);
    run(directory, ["git", "add", "."]);
    run(directory, [
      "git",
      "-c",
      "user.name=Release test",
      "-c",
      "user.email=release-test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "fixture",
    ]);
    // An uncommitted changeset prevents remote changelog metadata lookups.
    writeFileSync(
      path.join(directory, ".changeset/content-guard-test.md"),
      '---\n"@stll/cli": patch\n---\n\nRelease output boundary test.\n',
    );
    run(directory, ["git", "add", ".changeset/content-guard-test.md"]);
    const snapshot = (): Record<string, string> => {
      const output: Record<string, string> = {};
      const visit = (relative: string) => {
        for (const entry of readdirSync(path.join(directory, relative), {
          withFileTypes: true,
        })) {
          if ([".git", "node_modules"].includes(entry.name)) {
            continue;
          }
          const filename = path.join(relative, entry.name);
          if (entry.isDirectory()) {
            visit(filename);
          } else if (entry.isFile()) {
            output[filename] = readFileSync(
              path.join(directory, filename),
              "utf-8",
            );
          }
        }
      };
      visit("");
      return output;
    };
    const before = snapshot();
    run(directory, ["bun", "run", "changeset:version"]);
    const after = snapshot();
    for (const filename of [
      "packages/cli/package.json",
      ".changeset/content-guard-test.md",
      "bun.lock",
      "packages/cli/src/generated/cli-version.ts",
    ]) {
      expect(after[filename]).not.toBe(before[filename]);
    }
    check(before, after);
    for (const filename of ["packages/cli/src/generated/cli-version.ts"]) {
      const injected = `${after[filename] ?? ""}\nconsole.log("injected");\n`;
      expect(() => check(before, { ...after, [filename]: injected })).toThrow(
        "only the generated CLI version",
      );
    }
    const manifest = JSON.parse(after["packages/cli/package.json"] ?? "{}");
    expect(() =>
      check(before, {
        ...after,
        "packages/cli/package.json": JSON.stringify({
          ...manifest,
          scripts: { build: "injected" },
        }),
      }),
    ).toThrow("only package versions");
    const lock = after["bun.lock"] ?? "";
    expect(lock).toContain('"workspaces"');
    expect(() =>
      check(before, {
        ...after,
        "bun.lock": lock.replace(
          '"workspaces": {',
          '"injected": true, "workspaces": {',
        ),
      }),
    ).toThrow("only generated workspace versions");
    expect(() =>
      check(before, {
        ...after,
        "apps/api/src/injected.ts": "export const injected = true;",
      }),
    ).toThrow("not a versioning output");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
