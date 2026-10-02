import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  serializeCoverageDoc,
  type CoverageDocEntry,
} from "../apps/api/scripts/lib/capability-catalog";
import {
  capabilityDomainsOf,
  insertCapabilities,
  type CapabilityCatalogEntry,
} from "../packages/cli/src/generate-capability-tree";
import { generateRouteMap } from "../packages/cli/src/generate-route-map";
import { generateCliSkill } from "../packages/cli/src/generate-skill";
import type { RegistryToolListing } from "../packages/cli/src/route-types";

const root = path.resolve(import.meta.dir, "..");
const generated = Bun.spawnSync(
  [process.execPath, "--cwd=packages/cli", "run", "codegen:runtime"],
  { cwd: root, stdout: "pipe", stderr: "pipe" },
);
expect(generated.exitCode, generated.stderr.toString()).toBe(0);
const { generatedToolAnnotations: TOOL_ANNOTATIONS } =
  await import("../packages/cli/src/generated/tool-annotations");
const outputs = [
  "packages/cli/skills/stella-cli/SKILL.md",
  "docs/capability-coverage.md",
] as const;
const registry: RegistryToolListing[] = await Bun.file(
  path.join(root, "packages/cli/src/generated/registry-snapshot.json"),
).json();
const catalog: CapabilityCatalogEntry[] = await Bun.file(
  path.join(root, "packages/cli/capability-catalog.json"),
).json();
const { tree, stats } = insertCapabilities({
  tree: generateRouteMap(registry, TOOL_ANNOTATIONS),
  entries: catalog,
});
const capability = {
  tree,
  commandCount: stats.generated,
  domains: capabilityDomainsOf(tree),
};

const deterministicBytes = (emit: () => string): string => {
  const first = emit();
  expect(emit(), "generation must be byte-identical on repeated runs").toBe(
    first,
  );
  return first;
};

// Separated insertion anchors isolate column-width propagation. Adjacent sorted
// additions and edits to the same waiver count can still conflict legitimately.
const baseNames = ["alpha", "delta", "hotel", "lima", "papa", "tango", "zulu"];
const wideName = `bravo-${"wide-command-".repeat(24)}list`;
const otherName = "uniform-list";

const render = (repo: string) => {
  const names = readdirSync(path.join(repo, "inputs")).map((file) =>
    readFileSync(path.join(repo, "inputs", file), "utf-8").trim(),
  );
  const listings = names.map(
    (name) =>
      ({
        name: `merge_probe_${name}`,
        description: "Merge probe",
        inputSchema: { type: "object", properties: {} },
      }) satisfies RegistryToolListing,
  );
  const annotations = Object.fromEntries(
    names.map((name) => [
      `merge_probe_${name}`,
      { command: ["merge-probe", name] },
    ]),
  );
  const entries = names.map(
    (name) =>
      ({
        id: `merge-probe.${name}.list`,
        access: "read",
        destructive: false,
        scope: "stella:matters_write",
        transport: { type: "json" },
        mcp: { type: "tool", name: `merge_probe_${name}` },
      }) satisfies CoverageDocEntry,
  );
  return [
    deterministicBytes(() =>
      generateCliSkill(
        [...registry, ...listings],
        { ...TOOL_ANNOTATIONS, ...annotations },
        capability,
      ),
    ),
    deterministicBytes(() =>
      serializeCoverageDoc({
        entries,
        cliCommandPathById: new Map(),
        internalWaiverCounts: {},
      }),
    ),
  ];
};

const git = (repo: string, args: string[]) =>
  Bun.spawnSync(["git", ...args], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Merge fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Merge fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
const checkedGit = (repo: string, args: string[]) => {
  const result = git(repo, args);
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  return new TextDecoder().decode(result.stdout).trim();
};
const writeOutputs = (repo: string) => {
  const rendered = render(repo);
  for (const [index, output] of outputs.entries()) {
    const bytes = rendered.at(index);
    if (bytes === undefined) {
      panic("Missing rendered Markdown output");
    }
    mkdirSync(path.dirname(path.join(repo, output)), { recursive: true });
    writeFileSync(path.join(repo, output), bytes);
  }
  // Exercise the same formatter configuration as codegen/autofix, including
  // its scoped exclusions; a return to table padding must break the merge.
  const formatted = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      "oxfmt",
      "-c",
      ".oxfmtrc.json",
      "--no-error-on-unmatched-pattern",
      ...outputs,
    ],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  expect(formatted.exitCode, new TextDecoder().decode(formatted.stderr)).toBe(
    0,
  );
};

type MergeScenarioOptions = {
  scratch: string;
  padding: "excluded" | "enabled";
};

const mergeScenario = ({ scratch, padding }: MergeScenarioOptions) => {
  const seed = path.join(scratch, "seed");
  const repo = path.join(scratch, "clone");
  mkdirSync(seed);
  checkedGit(seed, ["init", "--initial-branch=base"]);
  copyFileSync(
    path.join(root, ".oxfmtrc.json"),
    path.join(seed, ".oxfmtrc.json"),
  );
  if (padding === "enabled") {
    const config: { ignorePatterns: string[] } = JSON.parse(
      readFileSync(path.join(seed, ".oxfmtrc.json"), "utf-8"),
    );
    // The negative control changes only formatter ownership of these outputs.
    // Both patterns must exist, so this mutation cannot silently become a no-op.
    for (const output of outputs) {
      expect(config.ignorePatterns).toContain(output);
    }
    config.ignorePatterns = config.ignorePatterns.filter(
      (pattern) => !outputs.some((output) => output === pattern),
    );
    writeFileSync(path.join(seed, ".oxfmtrc.json"), JSON.stringify(config));
  }
  writeFileSync(path.join(seed, ".gitignore"), "node_modules\n");
  mkdirSync(path.join(seed, "inputs"));
  for (const name of baseNames) {
    writeFileSync(path.join(seed, "inputs", `${name}.txt`), name);
  }
  checkedGit(seed, ["add", "."]);
  checkedGit(seed, ["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
  // Clone only this production-shaped fixture, never the active worktree.
  checkedGit(scratch, ["clone", "--no-hardlinks", seed, repo]);
  symlinkSync(path.join(root, "node_modules"), path.join(repo, "node_modules"));
  writeOutputs(repo);
  const baseBytes = outputs.map((output) =>
    readFileSync(path.join(repo, output), "utf-8"),
  );
  checkedGit(repo, ["add", ...outputs]);
  checkedGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
  const base = checkedGit(repo, ["rev-parse", "HEAD"]);
  for (const [branch, name] of [
    ["probe-a", wideName],
    ["probe-b", otherName],
  ] as const) {
    checkedGit(repo, ["switch", "-c", branch, base]);
    writeFileSync(path.join(repo, "inputs", `${branch}.txt`), name);
    checkedGit(repo, ["add", "inputs"]);
    checkedGit(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "input"]);
    checkedGit(repo, ["branch", `${branch}-inputs`]);
    writeOutputs(repo);
    for (const [index, output] of outputs.entries()) {
      const before = baseBytes.at(index);
      if (before === undefined) {
        panic("Missing base Markdown output");
      }
      const after = readFileSync(path.join(repo, output), "utf-8");
      expect(after).not.toBe(before);
      expect(after).toContain(name);
      if (name === wideName) {
        const marker = [
          "`stella merge-probe alpha`",
          "`merge-probe.alpha.list`",
        ].at(index);
        if (marker === undefined) {
          panic("Missing unchanged-row marker");
        }
        const beforeRow = before
          .split("\n")
          .find((line) => line.startsWith("|") && line.includes(marker));
        const afterRow = after
          .split("\n")
          .find((line) => line.startsWith("|") && line.includes(marker));
        if (beforeRow === undefined || afterRow === undefined) {
          panic("Fixture did not reach unchanged table row");
        }
        if (padding === "enabled") {
          expect(afterRow).not.toBe(beforeRow);
        } else {
          expect(afterRow).toBe(beforeRow);
        }
      }
    }
    checkedGit(repo, ["add", ...outputs]);
    checkedGit(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "generated",
    ]);
  }
  checkedGit(repo, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "probe-a-inputs",
    "probe-b-inputs",
  ]);
  const result = git(repo, [
    "merge-tree",
    "--write-tree",
    "--name-only",
    "probe-a",
    "probe-b",
  ]);
  if (padding === "enabled") {
    expect(result.exitCode).toBe(1);
    const conflicts = new TextDecoder().decode(result.stdout).split("\n");
    for (const output of outputs) {
      expect(conflicts).toContain(output);
    }
    return;
  }
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  const merged = new TextDecoder().decode(result.stdout).trim();
  expect(merged).toMatch(/^[a-f0-9]{40,64}$/u);
  checkedGit(repo, ["read-tree", "--reset", "-u", merged]);
  const mergedBytes = outputs.map((output) =>
    readFileSync(path.join(repo, output), "utf-8"),
  );
  expect(render(repo)).toEqual(mergedBytes);
  writeOutputs(repo);
  expect(
    outputs.map((output) => readFileSync(path.join(repo, output), "utf-8")),
  ).toEqual(mergedBytes);
};

for (const padding of ["excluded", "enabled"] as const) {
  test(`independent wide Markdown additions ${padding === "excluded" ? "merge and regenerate unchanged" : "conflict when padding is restored"}`, () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "stella-markdown-merge-"));
    try {
      mergeScenario({ scratch, padding });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
}

test("the determinism check rejects nondeterministic real emitters", () => {
  const emitters = [
    () => generateCliSkill(registry, TOOL_ANNOTATIONS, capability),
    () =>
      serializeCoverageDoc({
        entries: [],
        cliCommandPathById: new Map(),
        internalWaiverCounts: {},
      }),
  ];
  for (const emit of emitters) {
    let revision = 0;
    const mutated = () => `${emit()}\n<!-- mutation ${revision++} -->\n`;
    expect(mutated()).not.toBe(mutated());
    expect(() => deterministicBytes(mutated)).toThrow(
      /generation must be byte-identical/u,
    );
  }
});
