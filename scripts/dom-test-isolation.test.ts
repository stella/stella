import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// A test file that registers a DOM must not share its process with a file that
// loaded the same UI modules without one: Base UI and React pick their DOM
// strategy when a module first loads, so the order bun happens to run files in
// would decide whether DOM tests see a working component. Every workspace with
// such tests runs them isolated: `bun test --isolate`, or the web app's runner,
// which gives DOM tests their own process.
const ROOT = path.join(import.meta.dirname, "..");
const DOM_REGISTRATION = /GlobalRegistrator\.register\(/u;
const OWN_PROCESS_RUNNERS: ReadonlySet<string> = new Set(["apps/web"]);

const workspaceOf = (file: string): string =>
  file.split("/").slice(0, 2).join("/");

const domTestWorkspaces = (): string[] => {
  const files = [
    ...new Bun.Glob("{apps,packages}/*/src/**/*.test.{ts,tsx}").scanSync({
      cwd: ROOT,
    }),
    ...new Bun.Glob("{apps,packages}/*/tests/**/*.test.{ts,tsx}").scanSync({
      cwd: ROOT,
    }),
  ].filter((file) => !file.split("/").includes("node_modules"));
  return [
    ...new Set(
      files
        .filter((file) =>
          DOM_REGISTRATION.test(readFileSync(path.join(ROOT, file), "utf-8")),
        )
        .map(workspaceOf),
    ),
  ].toSorted();
};

const unitTestScripts = (workspace: string): string[] => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(ROOT, workspace, "package.json"), "utf-8"),
  );
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("scripts" in manifest) ||
    typeof manifest.scripts !== "object" ||
    manifest.scripts === null
  ) {
    return [];
  }
  return Object.entries(manifest.scripts).flatMap(([name, command]) =>
    (name === "test" || name === "test:unit") &&
    typeof command === "string" &&
    /\bbun test\b/u.test(command)
      ? [command]
      : [],
  );
};

describe("DOM test isolation", () => {
  test("the census finds the workspaces that register a DOM in tests", () => {
    expect(domTestWorkspaces()).toContain("packages/ui");
  });

  test("every workspace with DOM tests runs its test files isolated", () => {
    const unisolated = domTestWorkspaces()
      .filter((workspace) => !OWN_PROCESS_RUNNERS.has(workspace))
      .flatMap((workspace) => {
        const scripts = unitTestScripts(workspace);
        if (scripts.length === 0) {
          return [`${workspace}: no bun test script runs its DOM tests`];
        }
        return scripts
          .filter((command) => !command.includes("--isolate"))
          .map((command) => `${workspace}: ${command}`);
      });

    expect(unisolated).toEqual([]);
  });
});
