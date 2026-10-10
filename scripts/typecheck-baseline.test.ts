import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareField,
  deltaDiffs,
  diffAll,
  readBaselineAge,
} from "./typecheck-baseline";

test("baseline age is unavailable for shallow history and accurate for full history", () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "typecheck-age-git-"));
  const source = path.join(fixture, "source");
  const bare = path.join(fixture, "source.git");
  const full = path.join(fixture, "full");
  const shallow = path.join(fixture, "shallow");
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

  try {
    mkdirSync(source);
    git(source, "init", "--quiet");
    git(source, "config", "user.name", "Typecheck Test");
    git(source, "config", "user.email", "typecheck-test@example.invalid");
    git(source, "config", "commit.gpgsign", "false");
    mkdirSync(path.join(source, "scripts"));
    writeFileSync(path.join(source, "scripts/typecheck-baseline.json"), "{}\n");
    git(source, "add", "scripts/typecheck-baseline.json");
    git(source, "commit", "--quiet", "-m", "write baseline");
    const baselineSha = git(source, "rev-parse", "HEAD");
    writeFileSync(path.join(source, "unrelated.txt"), "next commit\n");
    git(source, "add", "unrelated.txt");
    git(source, "commit", "--quiet", "-m", "advance history");
    git(fixture, "clone", "--quiet", "--bare", source, bare);
    git(fixture, "clone", "--quiet", `file://${bare}`, full);
    git(fixture, "clone", "--quiet", "--depth=1", `file://${bare}`, shallow);

    expect(readBaselineAge(full)).toEqual({
      sha: baselineSha.slice(0, 10),
      date: git(full, "show", "-s", "--format=%cs", baselineSha),
      commits: 1,
    });
    expect(git(shallow, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(readBaselineAge(shallow)).toBeNull();
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("a change is compared with its merge base even when main has used the committed budget", () => {
  const committed = {
    api: { types: 1_000_000, instantiations: 8_000_000 },
    web: { types: 1_000_000, instantiations: 8_000_000 },
    "web-e2e": { types: 40_000, instantiations: 60_000 },
  } as const;
  const base = {
    api: { types: 1_100_000, instantiations: 9_000_000 },
    web: { types: 1_000_000, instantiations: 8_000_000 },
    "web-e2e": { types: 40_000, instantiations: 60_000 },
  } as const;
  const head = [
    {
      id: "api",
      counters: { types: 1_110_000, instantiations: 9_010_000 },
      context: "",
    },
    {
      id: "web",
      counters: { types: 1_000_000, instantiations: 8_000_000 },
      context: "",
    },
    {
      id: "web-e2e",
      counters: { types: 40_000, instantiations: 60_000 },
      context: "",
    },
  ] as const;

  expect(
    diffAll(head, committed).some((diff) => diff.status === "regressed"),
  ).toBe(true);
  expect(
    diffAll(head, base).filter((diff) => diff.status === "regressed"),
  ).toEqual([]);
});

test("the delta gate isolates a new explosion in one project and field", () => {
  const base = {
    api: { types: 1_000_000, instantiations: 8_000_000 },
    web: { types: 1_000_000, instantiations: 8_000_000 },
    "web-e2e": { types: 40_000, instantiations: 60_000 },
  } as const;
  const head = [
    {
      id: "api",
      counters: { types: 1_000_000, instantiations: 8_000_000 },
      context: "",
    },
    {
      id: "web",
      counters: { types: 1_010_000, instantiations: 16_000_000 },
      context: "",
    },
    {
      id: "web-e2e",
      counters: { types: 40_000, instantiations: 60_000 },
      context: "",
    },
  ] as const;

  expect(
    diffAll(head, base)
      .filter((diff) => diff.status === "regressed")
      .map((diff) => `${diff.id}.${diff.field}`),
  ).toEqual(["web.instantiations"]);
});

test("the per-change allowance uses the larger of percentage and floor", () => {
  expect(compareField("types", 1_050_000, 1_000_000)).toBe("ok");
  expect(compareField("types", 1_050_001, 1_000_000)).toBe("regressed");
  expect(compareField("types", 60_000, 40_000)).toBe("ok");
  expect(compareField("types", 60_001, 40_000)).toBe("regressed");
  expect(compareField("instantiations", 160_000, 60_000)).toBe("ok");
  expect(compareField("instantiations", 160_001, 60_000)).toBe("regressed");
});

test("a project new in the change is left to the committed budget", () => {
  const base = {
    api: { types: 1_000_000, instantiations: 8_000_000 },
    web: { types: 1_000_000, instantiations: 8_000_000 },
    "web-e2e": { types: 0, instantiations: 0 },
  } as const;
  const head = [
    {
      id: "api",
      counters: { types: 1_000_000, instantiations: 8_000_000 },
      context: "",
    },
    {
      id: "web-e2e",
      counters: { types: 40_000, instantiations: 60_000 },
      context: "",
    },
  ] as const;

  expect(deltaDiffs(head, base).map((diff) => diff.id)).toEqual(["api", "api"]);
  expect(
    diffAll(head, base).some(
      (diff) => diff.id === "web-e2e" && diff.status === "regressed",
    ),
  ).toBe(true);
});
