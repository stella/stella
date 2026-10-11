import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
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
  const match = /^channel = "([^"]+)"$/mu.exec(
    readFileSync(path.join(root, file), "utf-8"),
  );
  if (match?.[1] === undefined) {
    throw new Error(`${file} declares no toolchain channel`);
  }
  return match[1];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ToolchainUse = { file: string; job: string; version: string };

// Every Rust toolchain a workflow job selects: setup-action inputs and
// RUSTUP_TOOLCHAIN at workflow, job or step level.
const toolchainUses = (): ToolchainUse[] =>
  [
    ...new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync({ cwd: root }),
  ].flatMap((file) => {
    const workflow: unknown = Bun.YAML.parse(
      readFileSync(path.join(root, file), "utf-8"),
    );
    if (!isRecord(workflow) || !isRecord(workflow["jobs"])) {
      return [];
    }
    const workflowEnv = isRecord(workflow["env"]) ? workflow["env"] : {};
    return Object.entries(workflow["jobs"]).flatMap(([job, body]) => {
      if (!isRecord(body)) {
        return [];
      }
      const steps = Array.isArray(body["steps"]) ? body["steps"] : [];
      const versions = [
        workflowEnv["RUSTUP_TOOLCHAIN"],
        isRecord(body["env"]) ? body["env"]["RUSTUP_TOOLCHAIN"] : undefined,
        ...steps.flatMap((step: unknown) =>
          isRecord(step)
            ? [
                isRecord(step["env"])
                  ? step["env"]["RUSTUP_TOOLCHAIN"]
                  : undefined,
                typeof step["uses"] === "string" &&
                step["uses"].startsWith("dtolnay/rust-toolchain@")
                  ? // Without an input the action installs its floating default.
                    ((isRecord(step["with"])
                      ? step["with"]["toolchain"]
                      : undefined) ?? "stable")
                  : undefined,
              ]
            : [],
        ),
      ];
      return versions.flatMap((version) =>
        version === undefined ? [] : [{ file, job, version: String(version) }],
      );
    });
  });

const jobSource = (file: string, job: string): string =>
  JSON.stringify(
    (
      Bun.YAML.parse(readFileSync(path.join(root, file), "utf-8")) as {
        jobs: Record<string, unknown>;
      }
    ).jobs[job],
  );

test("Rust toolchains are exact versions, never a floating channel", () => {
  for (const crate of CRATES) {
    expect(channel(crate.toolchainFile), crate.toolchainFile).toMatch(
      EXACT_VERSION,
    );
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
