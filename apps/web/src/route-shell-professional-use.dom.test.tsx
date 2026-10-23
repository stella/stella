import { declareRouteShellProviderFixture } from "@/__fixtures__/route-shell/route-shell-provider-fixture";

// The fixture registers a browser environment and module mocks for the whole
// process, so it runs in the isolated DOM lane, never beside unit suites.
await declareRouteShellProviderFixture({
  mode: "public-knowledge",
  suite: "professional-use",
});
