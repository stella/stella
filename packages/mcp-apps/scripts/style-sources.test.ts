import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  declaredStyleSources,
  mcpAppEntries,
  reachedStyleSources,
  STYLE_SOURCES_BEGIN,
  STYLE_SOURCES_END,
  unscannedStyleSources,
  withStyleSources,
} from "./style-sources";

const withRepository = (
  files: Record<string, string>,
  run: (root: string) => void,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "mcp-style-sources-"));
  try {
    for (const [file, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), contents);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const BLOCK = `${STYLE_SOURCES_BEGIN}\n${STYLE_SOURCES_END}\n`;

describe("MCP app style sources", () => {
  test("lists the shared UI modules an app reaches and nothing else", () => {
    withRepository(
      {
        // Dependencies stay outside the walk; the JSX runtime is one.
        "node_modules/react/package.json":
          '{ "name": "react", "main": "index.js" }',
        "node_modules/react/index.js": "",
        "node_modules/react/jsx-dev-runtime.js": "",
        "packages/mcp-apps/src/app/app.tsx": [
          'import "../shared/generated/style.css";',
          'import { Badge } from "../../../ui/src/badge";',
          'import type { Shape } from "../../../ui/src/shape";',
          'import { DECISION } from "../../../decision-reader/src/decision";',
          'import { fold } from "../../../legal-ast/src/fold";',
          "export const App = (shape: Shape) => <Badge>{DECISION}{fold(shape)}</Badge>;",
        ].join("\n"),
        "packages/ui/src/badge.tsx": [
          'import { cn } from "./cn";',
          'export const Badge = (props: object) => <span className={cn("px-1")} {...props} />;',
        ].join("\n"),
        "packages/ui/src/cn.ts": "export const cn = (name: string) => name;",
        "packages/ui/src/shape.ts": "export type Shape = string;",
        "packages/ui/src/unused.tsx":
          'export const Unused = () => <span className="mt-97" />;',
        "packages/decision-reader/src/decision.ts":
          'export const DECISION = "decision";',
        "packages/legal-ast/src/fold.ts":
          "export const fold = (text: string) => text;",
      },
      (root) => {
        expect(
          reachedStyleSources({
            repoRoot: root,
            entries: [path.join(root, "packages/mcp-apps/src/app/app.tsx")],
          }),
        ).toEqual([
          "packages/decision-reader/src/decision.ts",
          "packages/ui/src/badge.tsx",
          "packages/ui/src/cn.ts",
        ]);
      },
    );
  });

  test("refuses markup the stylesheet would never scan", () => {
    withRepository(
      {
        "packages/mcp-apps/src/app/app.tsx":
          'export { Panel } from "../../../chat/src/panel";',
        "packages/chat/src/panel.tsx":
          'export const Panel = () => <div className="p-3" />;',
      },
      (root) => {
        expect(() =>
          reachedStyleSources({
            repoRoot: root,
            entries: [path.join(root, "packages/mcp-apps/src/app/app.tsx")],
          }),
        ).toThrow("packages/chat/src/panel.tsx");
      },
    );
  });

  test("names every bundled UI module the stylesheet does not scan", () => {
    const css = withStyleSources(BLOCK, ["packages/ui/src/badge.tsx"]);
    expect(declaredStyleSources(css)).toEqual(["packages/ui/src/badge.tsx"]);
    expect(
      unscannedStyleSources(
        [
          "packages/ui/src/badge.tsx",
          "packages/ui/src/tooltip.tsx",
          "packages/decision-reader/src/court-name.tsx",
          "packages/ui/src/theme.css",
          "packages/legal-ast/src/inline.ts",
          "packages/mcp-apps/src/citation-graph/app.tsx",
        ],
        css,
      ),
    ).toEqual([
      "packages/decision-reader/src/court-name.tsx",
      "packages/ui/src/tooltip.tsx",
    ]);
  });

  test("the committed stylesheet scans exactly what the apps reach", () => {
    const css = readFileSync(
      path.join(import.meta.dirname, "../src/shared/style.css"),
      "utf-8",
    );
    expect(declaredStyleSources(css)).toEqual(
      reachedStyleSources({ entries: mcpAppEntries() }),
    );
  });
});
