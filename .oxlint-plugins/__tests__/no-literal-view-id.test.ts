import { describe, expect, test } from "bun:test";

import { VIEW_ID_OWNERS } from "../no-literal-view-id.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const lint = async (
  source: string,
  sourcePath = "apps/web/src/components/matter-link.tsx",
) => await lintSingleRule("no-literal-view-id", source, { sourcePath });

// One flagged form per line, numbered from 1.
const viewIdPositions = [
  'const route = { params: { workspaceId, viewId: "all" } };',
  "const template = { viewId: `all` };",
  'const element = <Viewer viewId="all" />;',
  'const braced = <Viewer viewId={"all"} />;',
  'const fallback = match?.params.viewId ?? "all";',
  'const select = (params) => params.viewId || "all";',
  'const currentViewId = segments[3] ?? "all";',
  'const conditional = { viewId: other ? viewId : "all" };',
  'const ALL_VIEW_ID = "all";',
  'const open = ({ viewId = "all" }) => viewId;',
  'const isDefault = params.viewId === "all";',
  'type Route = { params: { workspaceId: string; viewId: "all" } };',
  'target.viewId = "all";',
  'const typed = { viewId: "all" as const };',
].join("\n");

const unrelatedSlugs = [
  'const filter = "all";',
  'const scope = { kind: "all" };',
  'const reviewId = "all";',
  'const marks = <Marks filter="all" />;',
  'const notesFilter = state.filter ?? "all";',
  "const route = { params: { workspaceId, viewId: DEFAULT_WORKSPACE_VIEW_ID } };",
  'const isAll = mode === "all";',
].join("\n");

const flaggedLines = Array.from(
  { length: viewIdPositions.split("\n").length },
  (_, index) => index + 1,
);

describe("default view slug", () => {
  test("rejects the slug in every view-id position", async () => {
    expect(await lint(viewIdPositions)).toEqual(flaggedLines);
  });

  test("accepts the same word where it names no view", async () => {
    expect(await lint(unrelatedSlugs)).toEqual([]);
  });

  test("admits the slug only in its owner, tests included", async () => {
    // This pinned boundary fails when an owner exemption is added.
    expect(VIEW_ID_OWNERS).toEqual([
      "apps/web/src/lib/workspaces/view-params.logic.ts",
    ]);
    const cases = [
      {
        sourcePath: "apps/web/src/lib/workspaces/view-params.logic.ts",
        expected: [],
      },
      {
        sourcePath: "apps/web/src/lib/workspaces/view-params.logic.test.ts",
        expected: [1],
      },
      {
        sourcePath: "apps/web/src/lib/other/view-params.logic.ts",
        expected: [1],
      },
    ];
    const results = await Promise.all(
      cases.map(async ({ sourcePath }) => ({
        sourcePath,
        result: await lint(
          'export const DEFAULT_WORKSPACE_VIEW_ID = "all";',
          sourcePath,
        ),
      })),
    );
    expect(results).toEqual(
      cases.map(({ sourcePath, expected }) => ({
        sourcePath,
        result: expected,
      })),
    );
  });
});
