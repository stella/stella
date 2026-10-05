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
  test("type-only imports cannot trigger runtime admission", async () => {
    for (const declaration of [
      'import type { ListData } from "@/lib/workspaces/queries/legal-lists";',
      'import { type ListData } from "@/lib/workspaces/queries/legal-lists";',
    ]) {
      expect(
        await lint(
          `import { createFileRoute } from "@tanstack/react-router";\n${declaration}\nexport const Route = createFileRoute("/fixture")({ component: () => null });`,
        ),
      ).toEqual([]);
    }
    expect(
      await lint(
        'import { createFileRoute } from "@tanstack/react-router";\nimport { type ListData, legalListsOptions } from "@/lib/workspaces/queries/legal-lists";\nexport const Route = createFileRoute("/fixture")({ loader: () => legalListsOptions() });',
      ),
    ).toEqual([2]);
  });
  test("relative imports have the same admission contract as aliases", async () => {
    const prefix =
      'import { createFileRoute } from "@tanstack/react-router";\nimport { legalListsOptions } from "../lib/workspaces/queries/legal-lists.ts";\n';
    expect(
      await lint(
        `${prefix}export const Route = createFileRoute("/fixture")({ loader: async () => { await legalListsOptions(); } });`,
      ),
    ).toEqual([2]);
    expect(
      await lint(
        `${prefix}import { loadCallerFeature } from "../lib/organization/feature-access/access.ts";\nexport const Route = createFileRoute("/fixture")({ loader: async () => { await loadCallerFeature({ load: async () => { await legalListsOptions(); } }); } });`,
      ),
    ).toEqual([]);
    expect(
      await lint(
        'import { createFileRoute } from "@tanstack/react-router";\nconst page = import("../features/avt/avt-route.tsx");\nexport const Route = createFileRoute("/fixture")({ component: page });',
      ),
    ).toEqual([2]);
  });
  test("feature reads execute only inside the admission callback", async () => {
    const prefix =
      'import { createFileRoute } from "@tanstack/react-router";\nimport { legalListsOptions } from "@/lib/workspaces/queries/legal-lists";\nimport { loadCallerFeature } from "@/lib/organization/feature-access/access";\n';
    for (const body of [
      "await legalListsOptions(); await loadCallerFeature({ load: async () => {} });",
      "await loadCallerFeature({ load: async () => {} }); await legalListsOptions();",
    ]) {
      expect(
        await lint(
          `${prefix}export const Route = createFileRoute("/fixture")({ loader: async () => { ${body} } });`,
        ),
      ).toEqual([2]);
    }
    expect(
      await lint(
        `${prefix}export const Route = createFileRoute("/fixture")({ loader: async () => { await loadCallerFeature({ load: async () => { await legalListsOptions(); } }); } });`,
      ),
    ).toEqual([]);
  });
  test("an unrelated object's loader cannot admit the route", async () => {
    expect(
      await lint(
        'import { createFileRoute } from "@tanstack/react-router";\nimport { legalListsOptions } from "@/lib/workspaces/queries/legal-lists";\nimport { loadCallerFeature } from "@/lib/organization/feature-access/access";\nconst unrelated = { loader: async () => { await loadCallerFeature({ load: legalListsOptions }); } };\nexport const Route = createFileRoute("/fixture")({ loader: async () => { await legalListsOptions(); } });',
      ),
    ).toEqual([2]);
  });
  test("admission belongs to each route in a multi-route module", async () => {
    expect(
      await lint(
        'import { createFileRoute } from "@tanstack/react-router";\nimport { legalListsOptions } from "@/lib/workspaces/queries/legal-lists";\nimport { loadCallerFeature } from "@/lib/organization/feature-access/access";\nexport const First = createFileRoute("/first")({ loader: async () => { await loadCallerFeature({ load: legalListsOptions }); } });\nexport const Second = createFileRoute("/second")({ component: () => null });',
      ),
    ).toEqual([2]);
  });
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
