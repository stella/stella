import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

const root = path.resolve(import.meta.dir, "..");
const PINNED_VERSION = "1.99.1";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;

// Each crate owns its pin; rustup finds it from the package directory, so
// package scripts that pass --manifest-path still resolve it.
const CRATES = [
  {
    name: "desktop",
    toolchainFile: "apps/desktop/rust-toolchain.toml",
    marker: "apps/desktop/src-tauri",
  },
  {
    name: "scan-engine",
    toolchainFile: "packages/scan-engine/rust-toolchain.toml",
    marker: "packages/scan-engine",
  },
] as const;

const channel = (file: string): string => {
  if (path.basename(file) === "rust-toolchain") {
    return readFileSync(path.join(root, file), "utf-8").trim();
  }
  const match = /^channel = "([^"]+)"$/mu.exec(
    readFileSync(path.join(root, file), "utf-8"),
  );
  if (match?.[1] === undefined) {
    throw new Error(`${file} declares no toolchain channel`);
  }
  return match[1];
};

const trackedToolchains = (): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) =>
      ["rust-toolchain.toml", "rust-toolchain"].includes(path.basename(file)),
    );
};

const environmentSchema = v.optional(v.record(v.string(), v.unknown()), {});
const workflowSchema = v.looseObject({
  env: environmentSchema,
  jobs: v.record(
    v.string(),
    v.looseObject({
      env: environmentSchema,
      steps: v.optional(
        v.array(
          v.looseObject({
            env: environmentSchema,
            uses: v.optional(v.string()),
            with: environmentSchema,
          }),
        ),
        [],
      ),
    }),
  ),
});
const readWorkflow = (file: string) =>
  v.parse(
    workflowSchema,
    Bun.YAML.parse(readFileSync(path.join(root, file), "utf-8")),
  );

type ToolchainUse = { file: string; job: string; version: string };

// Every Rust toolchain a workflow job selects: setup-action inputs and
// RUSTUP_TOOLCHAIN at workflow, job or step level.
const toolchainUses = (): ToolchainUse[] =>
  [
    ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root }),
  ].flatMap((file) => {
    const workflow = readWorkflow(file);
    return Object.entries(workflow.jobs).flatMap(([job, body]) => {
      const versions = [
        workflow.env["RUSTUP_TOOLCHAIN"],
        body.env["RUSTUP_TOOLCHAIN"],
        ...body.steps.flatMap((step) => [
          step.env["RUSTUP_TOOLCHAIN"],
          step.uses?.startsWith("dtolnay/rust-toolchain@")
            ? // Without an input the action installs its floating default.
              (step.with["toolchain"] ?? "stable")
            : undefined,
        ]),
      ];
      return versions.flatMap((version) =>
        version === undefined
          ? []
          : [{ file, job, version: v.parse(v.string(), version) }],
      );
    });
  });

const jobSource = (file: string, job: string): string =>
  JSON.stringify(readWorkflow(file).jobs[job]);

test("Rust toolchains are exact versions, never a floating channel", () => {
  const files = trackedToolchains();
  for (const crate of CRATES) {
    expect(files).toContain(crate.toolchainFile);
  }
  for (const file of files) {
    expect(channel(file), file).toMatch(EXACT_VERSION);
  }
  const uses = toolchainUses();
  expect(uses.length).toBeGreaterThan(0);
  for (const { file, job, version } of uses) {
    expect(version, `${file} ${job}`).toMatch(EXACT_VERSION);
  }
});

test("each workflow job uses the pin of the crate it builds", () => {
  const counts = new Map<string, number>();
  for (const { file, job, version } of toolchainUses()) {
    const source = jobSource(file, job);
    const named = CRATES.filter(({ marker }) => source.includes(marker));
    // Repository-wide jobs (autofix) override every crate; they use the
    // repository default, the desktop pin.
    const built = named.length > 0 ? named : [CRATES[0]];
    const label = `${file} ${job}`;
    for (const crate of built) {
      expect(version, label).toBe(channel(crate.toolchainFile));
      counts.set(crate.name, (counts.get(crate.name) ?? 0) + 1);
    }
  }
  // Both crates are built by at least one job, so the binding is exercised.
  for (const { name } of CRATES) {
    expect(counts.get(name) ?? 0, name).toBeGreaterThan(0);
  }
});

test("every tracked Rust toolchain file uses the repository pin", () => {
  const files = trackedToolchains();
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(channel(file), file).toBe(PINNED_VERSION);
  }
});
