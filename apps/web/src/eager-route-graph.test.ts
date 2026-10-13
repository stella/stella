import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import nodePath from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import { walkEagerGraph } from "./eager-route-graph.logic";

const SOURCE_ROOT = import.meta.dir;
const EAGER_BOUNDARIES = {
  "lib/account/storage-families.ts": [
    "@/lib/law-search-history/law-search-history.logic",
  ],
  "features/case-law/case-decision-inspector-registration.tsx": [
    "@/features/case-law/components/case-decision-rail-icon",
  ],
  "features/case-law/case-decision-details-inspector-registration.tsx": [
    "@/features/case-law/components/case-decision-rail-icon",
  ],
  "features/statutes/provision-inspector-registration.tsx": [
    "@/features/statutes/provision-inspector.logic",
  ],
  "routes/-protected-app.tsx": [
    "@/lib/organization/feature-access/capability-actions",
    "@/lib/organization/feature-access/action-capabilities.logic",
  ],
  "routes/law/cases/index.tsx": [
    "@/components/public-law-table/public-law-pagination.logic",
    "@/features/case-law/case-law-pages.logic",
  ],
} as const;
describe("eager route graph", () => {
  test("keeps route-only feature modules behind lazy imports", () => {
    const violations: string[] = [];
    for (const [entry, forbidden] of Object.entries(EAGER_BOUNDARIES)) {
      const graph = walkEagerGraph({ root: SOURCE_ROOT, entry, forbidden });
      expect(graph.visited.size).toBeGreaterThan(1);
      violations.push(...graph.violations);
    }
    expect(violations).toEqual([]);
  });

  test.each([
    'import { value } from "./feature"; export { value };',
    'export { value } from "./feature";',
    'export * from "./feature";',
    'import "./feature";',
  ])("rejects an indirect eager dependency through %s", (mutation) => {
    const root = nodePath.resolve(SOURCE_ROOT, "__virtual_eager_graph__");
    const files = new Map([
      ["entry.ts", 'import { value } from "@/bridge"; export { value };'],
      ["bridge/index.ts", 'export { value } from "../intermediate";'],
      [
        "intermediate.tsx",
        `import type { Feature } from "@/feature";
        export type { Feature } from "./feature";
        import { type Feature as InlineFeature } from "./feature";
        export { type Feature as InlineExport } from "./feature";
        export const value = () => import("./feature");
        const view = <Component {...props} key="fixture" />;`,
      ],
      ["feature.ts", "export type Feature = string; export const value = 1;"],
    ]);
    const options = {
      root,
      entry: "entry.ts",
      forbidden: ["@/feature"],
      isFile: (file: string) => files.has(repoRelativePath(root, file)),
      readSource: (file: string) => {
        const source = files.get(repoRelativePath(root, file));
        assert.ok(source !== undefined, `Missing fixture module ${file}`);
        return source;
      },
    };
    const lazyGraph = walkEagerGraph(options);
    expect(
      [...lazyGraph.visited].map((file) => repoRelativePath(root, file)),
    ).toEqual(["entry.ts", "bridge/index.ts", "intermediate.tsx"]);
    expect(lazyGraph.violations).toEqual([]);
    expect(files.get("intermediate.tsx")).not.toBe(mutation);
    files.set("intermediate.tsx", mutation);
    expect(walkEagerGraph(options).violations).toEqual([
      "entry.ts -> bridge/index.ts -> intermediate.tsx -> feature.ts",
    ]);
  });
});
