import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { CALLER_FEATURE } from "../../apps/web/src/lib/organization/feature-access/surfaces.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);
const RULE = "require-caller-feature-access";
const PATH = "apps/web/src/routes/_protected.fixture.tsx";
const lint = async (source: string) =>
  await lintSingleRule(RULE, source, { sourcePath: PATH });

describe.serial("caller feature route census", () => {
  for (const feature of Object.values(CALLER_FEATURE)) {
    for (const source of feature.routeImports) {
      test(`requires the loader owner for routes importing ${source}`, async () => {
        const path = source.endsWith("/") ? `${source}queries` : source;
        const prefix = `import { createFileRoute } from "@tanstack/react-router";\nimport { dataOptions } from "${path}";\n`;
        expect(
          await lint(
            `${prefix}export const Route = createFileRoute("/fixture")({ loader: async () => { await dataOptions(); } });`,
          ),
        ).toEqual([2]);
        expect(
          await lint(
            `${prefix}import { loadCallerFeature as admit } from "@/lib/organization/feature-access/access";\nexport const Route = createFileRoute("/fixture")({ loader: async () => { await admit({ load: dataOptions }); } });`,
          ),
        ).toEqual([]);
        expect(
          await lint(
            `${prefix}import { loadCallerFeature } from "@/lib/organization/feature-access/access";\nexport const Route = createFileRoute("/fixture")({ loader: async () => { loadCallerFeature({ load: dataOptions }); } });`,
          ),
        ).toEqual([2]);
      });
      test(`enumerates lazy routes importing ${source}`, async () => {
        const path = source.endsWith("/") ? `${source}view` : source;
        expect(
          await lint(
            `import { createFileRoute } from "@tanstack/react-router";\nconst page = import("${path}");\nexport const Route = createFileRoute("/fixture")({ component: page });`,
          ),
        ).toEqual([2]);
      });
    }
  }
  test("forbids build flags and stored preview state", async () => {
    expect(
      await lint(
        "export const build = env.VITE_FEATURE_LEGAL_LISTS;\nexport const preview = store.avtPreview;\nconst { VITE_FEATURE_LEGAL_LISTS: copied } = env;",
      ),
    ).toEqual([1, 2, 3]);
  });
  test("ordinary routes need no caller-feature gate", async () => {
    expect(
      await lint(
        'import { createFileRoute } from "@tanstack/react-router";\nexport const Route = createFileRoute("/fixture")({ loader: async () => {} });',
      ),
    ).toEqual([]);
  });
});
