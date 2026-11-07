import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (source: string) =>
  lintSingleRule("no-raw-workspace-status", source, {
    sourcePath: "source.ts",
  });

test("rejects a workspace status compared with a string literal", async () => {
  expect(
    await lint(
      'const a = (workspace: { status: string }) => workspace.status === "archived";',
    ),
  ).toEqual([1]);
  expect(
    await lint(
      'const a = (matter?: { status: string }) => matter?.status !== "active";',
    ),
  ).toEqual([1]);
  expect(
    await lint(
      'const a = (row: { workspace: { status: string } }) => "deleting" === row.workspace.status;',
    ),
  ).toEqual([1]);
});

test("rejects SQL comparisons of the workspace status column with a literal", async () => {
  expect(
    await lint(
      'declare const ne: Function, workspaces: { status: unknown };\nconst a = ne(workspaces.status, "deleting");',
    ),
  ).toEqual([2]);
  expect(
    await lint(
      'declare const inArray: Function, workspaces: { status: unknown };\nconst a = inArray(workspaces.status, ["active", "archived"]);',
    ),
  ).toEqual([2]);
});

test("rejects a namespaced SQL comparison", async () => {
  expect(
    await lint(
      'declare const d: { ne: Function }, workspaces: { status: unknown };\nconst a = d.ne(workspaces.status, "deleting");',
    ),
  ).toEqual([2]);
});

test("allows the domain's constants and other statuses", async () => {
  expect(
    await lint(
      'declare const WORKSPACE_STATUS: { archived: "archived" };\nconst a = (workspace: { status: string }) => workspace.status === WORKSPACE_STATUS.archived;',
    ),
  ).toEqual([]);
  // A run or list status is not a workspace status.
  expect(
    await lint(
      'const a = (run: { status: string }) => run.status === "active";',
    ),
  ).toEqual([]);
  expect(
    await lint(
      'const a = (workspace: { kind: string }) => workspace.kind === "active";',
    ),
  ).toEqual([]);
  // An entity named after a workspace is not one.
  expect(
    await lint(
      'const a = (workspaceMemory: { status: string }) => workspaceMemory.status === "archived";',
    ),
  ).toEqual([]);
  expect(
    await lint(
      'const a = (targetWorkspace: { status: string }) => targetWorkspace.status === "archived";',
    ),
  ).toEqual([1]);
});
