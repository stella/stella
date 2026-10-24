import { declareRouteShellProviderFixture } from "@/__fixtures__/route-shell/route-shell-provider-fixture";
import { parseRouteSearch } from "@/route-search-params";

await declareRouteShellProviderFixture({
  mode: "public-knowledge",
  suite: "route-search",
  parseSearch: parseRouteSearch,
});
