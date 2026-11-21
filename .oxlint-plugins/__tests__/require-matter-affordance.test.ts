import { expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const cases = [
  {
    title: "reports ambiguous raw matter link",
    source: 'const view = <Link to="/workspaces/$workspaceId" />;',
    lines: [1],
    sourcePath: "source.tsx",
  },
  {
    title: "allows listing menu and explicit references",
    source:
      'const view = <><MatterContextMenu><Link to="/workspaces/$workspaceId" /></MatterContextMenu><MatterRefLink workspaceId={id} /></>;',
    lines: [],
    sourcePath: "source.tsx",
  },
  {
    title: "allows route control flow",
    source: 'const view = <Navigate to="/workspaces/$workspaceId" />;',
    lines: [],
    sourcePath: "source.tsx",
  },
];

test.each(cases)(
  "require-matter-affordance: $title",
  async ({ source, lines, sourcePath }) => {
    expect(
      (await runSingleRule("require-matter-affordance", source, { sourcePath }))
        .lines,
    ).toEqual(lines);
  },
);
