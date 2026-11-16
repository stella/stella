import { declareRouteShellProviderFixture as registerRouteShellProviderFixture } from "@/__fixtures__/route-shell/route-shell-provider-fixture";
import { parseRouteSearch } from "@/route-search-params";

await registerRouteShellProviderFixture({
  mode: "public-knowledge",
  suite: "route-search",
  parseSearch: parseRouteSearch,
});
