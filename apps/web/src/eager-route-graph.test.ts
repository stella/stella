import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

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
const STATIC_IMPORT =
  /(?:import\s+(?!type\b)(?:[^"']*?\sfrom\s*)?|export\s+(?!type\b)[^"']*?\sfrom\s*)["']([^"']+)["']/gu;

describe("eager route graph", () => {
  test("keeps route-only feature modules behind lazy imports", async () => {
    const violations: string[] = [];
    for (const [source, forbidden] of Object.entries(EAGER_BOUNDARIES)) {
      const text = await Bun.file(nodePath.join(SOURCE_ROOT, source)).text();
      const imports = [...text.matchAll(STATIC_IMPORT)].flatMap((match) => {
        const specifier = match.at(1);
        return specifier === undefined ? [] : [specifier];
      });
      for (const dependency of forbidden) {
        if (imports.includes(dependency)) {
          violations.push(`${source} -> ${dependency}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
