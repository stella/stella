import { QueryClient } from "@tanstack/react-query";
import { expect, test } from "bun:test";

import { declareRouteShellProviderFixture } from "@/__fixtures__/route-shell/route-shell-provider-fixture";

// The fixture registers a browser environment and module mocks for the whole
// process, so it runs in the isolated DOM lane, never beside unit suites.
await declareRouteShellProviderFixture({
  mode: "public-knowledge",
  suite: "professional-use",
});

const { requireProfessionalUseForSignedInRoute } =
  await import("@/routes/-auth-context");

test("a signed-out visitor passes the professional-use boundary without reading acceptance", async () => {
  const queryClient = new QueryClient();
  const signedOut = { session: null, user: null };
  try {
    expect(
      await requireProfessionalUseForSignedInRoute({
        authContext: signedOut,
        queryClient,
        location: { pathname: "/law/cze/cases", searchStr: "?q=contract" },
      }),
    ).toBe(signedOut);
    expect(queryClient.getQueryCache().getAll()).toEqual([]);
  } finally {
    queryClient.clear();
  }
});
