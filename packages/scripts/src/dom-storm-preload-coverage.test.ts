import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// Every DOM test runs under the render-storm check: a workspace with a
// `*.dom.test.ts(x)` file loads the check's preload, right after the
// event-loop watchdog (which test-event-loop-watchdog-coverage.test.ts keeps
// first), so the check's React hook is in place before any test file loads
// React DOM.
const ROOT = path.resolve(import.meta.dirname, "../../..");
const PRELOAD = "packages/render-probe/src/dom-test-preload.ts";
const WORKSPACE_PRELOAD = `../../${PRELOAD}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const preloads = (bunfig: string): readonly unknown[] => {
  const parsed: unknown = Bun.TOML.parse(bunfig);
  const section = isRecord(parsed) ? parsed["test"] : undefined;
  const preload = isRecord(section) ? section["preload"] : undefined;
  return Array.isArray(preload) ? preload : [preload];
};

// The workspaces (apps/*, packages/*) that hold a tracked DOM test.
const domTestWorkspaces = (): readonly string[] => {
  const listed = Bun.spawnSync(
    ["git", "ls-files", "--", "*.dom.test.ts", "*.dom.test.tsx"],
    { cwd: ROOT },
  );
  expect(listed.exitCode).toBe(0);
  const directories = listed.stdout
    .toString()
    .split("\n")
    .map((file) => file.split("/").slice(0, 2).join("/"))
    .filter(
      (directory) =>
        /^(?:apps|packages)\/[^/]+$/u.test(directory) &&
        existsSync(path.join(ROOT, directory, "package.json")),
    );
  return [...new Set(directories)].toSorted();
};

const workspaceViolation = (directory: string): string | undefined => {
  const bunfigFile = `${directory}/bunfig.toml`;
  if (!existsSync(path.join(ROOT, bunfigFile))) {
    return `${bunfigFile}: missing; list "${WORKSPACE_PRELOAD}" in [test] preload`;
  }
  const listed = preloads(readFileSync(path.join(ROOT, bunfigFile), "utf-8"));
  return listed.at(1) === WORKSPACE_PRELOAD
    ? undefined
    : `${bunfigFile}: list "${WORKSPACE_PRELOAD}" second in [test] preload, right after the watchdog`;
};

test("every workspace with DOM tests loads the render-storm check", () => {
  const violations = domTestWorkspaces().flatMap(
    (directory) => workspaceViolation(directory) ?? [],
  );
  expect(violations).toEqual([]);
});

test("the preload every workspace lists resolves to the check", () => {
  expect(existsSync(path.join(ROOT, "apps", "web", WORKSPACE_PRELOAD))).toBe(
    true,
  );
});

test("the coverage sees the DOM-test workspaces", () => {
  expect(domTestWorkspaces()).toEqual(
    expect.arrayContaining(["apps/desktop", "apps/web", "packages/ui"]),
  );
});
