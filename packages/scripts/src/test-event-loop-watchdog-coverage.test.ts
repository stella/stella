import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { guardEnforcesLine } from "../../../scripts/guard-rollouts.ts";

// Registered in scripts/guard-rollouts: enforced on changed lines first.
const GUARD = "test-event-loop-watchdog";
const ROOT = path.resolve(import.meta.dirname, "../../..");
const WATCHDOG = "packages/scripts/src/test-event-loop-watchdog.ts";
const WORKSPACE_PRELOAD = `../../${WATCHDOG}`;

// The API runner supervises its own batches: each has a wall-clock budget
// (apps/api/scripts/test-process-supervisor.ts) and buffers its output, so the
// silent-gap measurement that sets the watchdog's limit does not cover it.
// Root `bun test` runs (CI's pooled static checks) are not workspace tasks:
// each check has its own budget, and some block on a bounded spawnSync for
// minutes, so the root bunfig.toml does not load the watchdog.
const EXEMPT = {
  "apps/api": "its runner bounds every batch with a wall-clock budget",
} as const satisfies Record<string, string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const firstPreload = (bunfig: string): unknown => {
  const parsed: unknown = Bun.TOML.parse(bunfig);
  const section = isRecord(parsed) ? parsed["test"] : undefined;
  const preload = isRecord(section) ? section["preload"] : undefined;
  return Array.isArray(preload) ? preload.at(0) : preload;
};

const lineOf = (text: string, needle: string) =>
  Math.max(1, text.split("\n").findIndex((line) => line.includes(needle)) + 1);

type Violation = { readonly file: string; readonly line: number };

const workspaceViolation = (directory: string): Violation | undefined => {
  const manifestFile = `${directory}/package.json`;
  const manifest = readFileSync(path.join(ROOT, manifestFile), "utf-8");
  const parsed: unknown = JSON.parse(manifest);
  const scripts = isRecord(parsed) ? parsed["scripts"] : undefined;
  if (!isRecord(scripts) || typeof scripts["test"] !== "string") {
    return undefined;
  }
  const bunfigFile = `${directory}/bunfig.toml`;
  if (!existsSync(path.join(ROOT, bunfigFile))) {
    return { file: manifestFile, line: lineOf(manifest, '"test":') };
  }
  const bunfig = readFileSync(path.join(ROOT, bunfigFile), "utf-8");
  return firstPreload(bunfig) === WORKSPACE_PRELOAD
    ? undefined
    : { file: bunfigFile, line: lineOf(bunfig, "preload") };
};

const workspaces = () =>
  ["apps", "packages"].flatMap((parent) =>
    readdirSync(path.join(ROOT, parent), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(path.join(ROOT, parent, entry.name, "package.json")),
      )
      .map((entry) => `${parent}/${entry.name}`),
  );

test("every workspace test run loads the event-loop watchdog before its own preloads", () => {
  const violations = workspaces()
    .filter((directory) => !Object.hasOwn(EXEMPT, directory))
    .flatMap((directory) => workspaceViolation(directory) ?? [])
    .filter(({ file, line }) => guardEnforcesLine({ guard: GUARD, file, line }))
    .map(
      ({ file, line }) =>
        `${file}:${line}: list "${WORKSPACE_PRELOAD}" first in bunfig.toml [test] preload`,
    );
  expect(violations).toEqual([]);
});

test("the preload every workspace lists resolves to the watchdog", () => {
  expect(existsSync(path.join(ROOT, "packages", "ui", WORKSPACE_PRELOAD))).toBe(
    true,
  );
});

test("every exempt workspace exists and runs tests", () => {
  for (const directory of Object.keys(EXEMPT)) {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(ROOT, directory, "package.json"), "utf-8"),
    );
    const scripts = isRecord(parsed) ? parsed["scripts"] : undefined;
    expect(isRecord(scripts) && typeof scripts["test"] === "string").toBe(true);
  }
});

test("the guard finds a workspace that runs tests without the watchdog", () => {
  // apps/api is exempt, so it is the one real workspace without the preload.
  expect(workspaceViolation("apps/api")).toEqual({
    file: "apps/api/bunfig.toml",
    line: lineOf(
      readFileSync(path.join(ROOT, "apps/api/bunfig.toml"), "utf-8"),
      "preload",
    ),
  });
});
