import { panic, TaggedError } from "better-result";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateBunToolchain } from "./generate-bun-toolchain";
import { GENERATORS, type Generator } from "./generated-files";
import { runGeneratorChecks } from "./generated-files-guard";

const generator = (id: string) =>
  GENERATORS.find((entry) => entry.id === id) ??
  panic(`Missing generator ${id}`);

const checkedGenerator = (id: string) => {
  const entry = generator(id);
  if (entry.check === null) {
    panic(`Fixture needs a checked generator: ${id}`);
  }
  return entry;
};

class FixtureStartFailure extends TaggedError("FixtureStartFailure")<{
  message: string;
}> {}

test("runs every manifest check exactly once and continues after failed and rejected checks", async () => {
  const visited: string[] = [];
  const completed = new Set<string>();
  const failures = await runGeneratorChecks(GENERATORS, async (entry) => {
    for (const dependency of entry.after) {
      const predecessor = generator(dependency);
      if (predecessor.check !== null) {
        expect(completed.has(dependency)).toBe(true);
      }
    }
    visited.push(entry.id);
    await Promise.resolve();
    completed.add(entry.id);
    if (entry.id === "bun-toolchain") {
      return 1;
    }
    if (entry.id === "cloud-setup") {
      throw new FixtureStartFailure({
        message: "fixture process could not start",
      });
    }
    return 0;
  });
  const checked = GENERATORS.filter(({ check }) => check !== null).map(
    ({ id }) => id,
  );
  expect(visited.toSorted()).toEqual(checked.toSorted());
  expect(new Set(visited).size).toBe(checked.length);
  expect(failures.map(({ id }) => id).toSorted()).toEqual([
    "bun-toolchain",
    "cloud-setup",
  ]);
});

test("overlaps at most two audited checks and keeps new or changed commands exclusive", async () => {
  const checks = [
    generator("cloud-setup"),
    generator("bun-toolchain"),
    {
      ...checkedGenerator("bun-toolchain"),
      id: "new-command",
      check: ["bun", "different-generator.ts"],
    },
    generator("i18n-messages-landing"),
    generator("schema-index"),
  ] satisfies Generator[];
  const exclusive = new Set(["new-command", "schema-index"]);
  const active = new Set<string>();
  let peak = 0;
  const failures = await runGeneratorChecks(checks, async ({ id }) => {
    if (exclusive.has(id)) {
      expect(active.size).toBe(0);
    } else {
      expect([...active].some((running) => exclusive.has(running))).toBe(false);
    }
    active.add(id);
    peak = Math.max(peak, active.size);
    expect(active.size).toBeLessThanOrEqual(2);
    await Promise.resolve();
    active.delete(id);
    return 0;
  });
  expect(failures).toEqual([]);
  expect(peak).toBe(2);
});

test("every checked family remains a failure when its check reports a violation", async () => {
  const failures = await runGeneratorChecks(GENERATORS, async () => 1);
  expect(failures).toEqual(
    GENERATORS.filter(({ check }) => check !== null).map(({ id }) => ({
      id,
      failure: "exit 1",
    })),
  );
});

test("preserves dependency barriers through unchecked families even after upstream failure", async () => {
  const upstream = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const visited: string[] = [];
  const checks = [
    { ...generator("bun-toolchain"), id: "upstream", after: [] },
    { ...generator("cli-runtime"), id: "unchecked", after: ["upstream"] },
    { ...generator("cloud-setup"), id: "downstream", after: ["unchecked"] },
  ] satisfies Generator[];
  const result = runGeneratorChecks(checks, async ({ id }) => {
    visited.push(id);
    if (id === "upstream") {
      started.resolve(undefined);
      await upstream.promise;
      return 1;
    }
    return 0;
  });
  await started.promise;
  expect(visited).toEqual(["upstream"]);
  upstream.resolve(undefined);
  expect(await result).toEqual([{ id: "upstream", failure: "exit 1" }]);
  expect(visited).toEqual(["upstream", "downstream"]);
});

test("matches sequential generator findings including stale and missing committed outputs", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "generator-check-equivalence-"),
  );
  try {
    const fixtures = ["valid", "stale", "missing"] as const;
    for (const fixture of fixtures) {
      const directory = path.join(root, fixture);
      await mkdir(path.join(directory, "scripts"), { recursive: true });
      await writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({ packageManager: "bun@1.4.3" }),
      );
      if (fixture !== "missing") {
        await writeFile(
          path.join(directory, "scripts/bun-toolchain.gen.json"),
          `${JSON.stringify({ packageManager: fixture === "stale" ? "bun@0.0.1" : "bun@1.4.3" }, null, 2)}\n`,
        );
      }
    }
    const checks = fixtures.map((id) => ({
      ...generator("bun-toolchain"),
      id,
    }));
    const check = async ({ id }: Generator) =>
      generateBunToolchain(path.join(root, id), false);
    const sequential: { id: string; failure: string }[] = [];
    for (const entry of checks) {
      const code = await check(entry);
      if (code !== 0) {
        sequential.push({ id: entry.id, failure: `exit ${code}` });
      }
    }
    expect(sequential).toEqual([
      { id: "stale", failure: "exit 1" },
      { id: "missing", failure: "exit 1" },
    ]);
    expect(await runGeneratorChecks(checks, check)).toEqual(sequential);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
