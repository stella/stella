import { plugin } from "bun";
import { transformSync } from "oxc-transform-react";

import { REACT_COMPILER_OPTIONS } from "@stll/scripts/src/react-compiler-options";

import { parseRouteSearch } from "@/route-search-params";

// Run the page with the same compiler transform as the browser build.
plugin({
  name: "case-search-production-compiler",
  setup(build) {
    build.onLoad(
      {
        filter:
          /(?:-case-law-index-page|-case-law-index-error|-statutes-index-error|statutes[/\\]index|public-law-list-failure)\.tsx$/u,
      },
      async ({ path }) => {
        const source = await Bun.file(path).text();
        const result = transformSync(path, source, {
          lang: "tsx",
          jsx: "preserve",
          reactCompiler: REACT_COMPILER_OPTIONS,
        });
        return { contents: result.code, loader: "tsx" };
      },
    );
  },
});
const { declareRouteShellProviderFixture: registerRouteShellProviderFixture } =
  await import("@/__fixtures__/route-shell/route-shell-provider-fixture");
await registerRouteShellProviderFixture({
  mode: "public-knowledge",
  suite: "case-search",
  parseSearch: parseRouteSearch,
});
