import { panic } from "better-result";
import { expect, test } from "bun:test";

import { declareRouteShellProviderFixture } from "@/__fixtures__/route-shell/route-shell-provider-fixture";

const fixture = await declareRouteShellProviderFixture({
  mode: "public-knowledge",
  suite: "chat-composer",
});
const { Route } = await import("@/routes/_protected.chat/index");
const { getByRole } = await import("@testing-library/dom");

test("direct chat route mounts its editable composer through the actual member frame", async () => {
  fixture.state.audience = "member";
  const { router, queryClient, caughtErrors } =
    fixture.createFixtureRouter("/chat");
  await fixture.initializeI18n();
  try {
    await fixture.act(async () => {
      await router.load();
      fixture.render(<fixture.RouterProvider router={router} />, {
        container: document,
        onCaughtError: (error) => {
          caughtErrors.push(
            error instanceof Error ? error : panic(String(error)),
          );
        },
      });
    });
    await fixture.waitFor(() => {
      const composer = getByRole(document.body, "textbox", {
        name: /^Type your question/u,
      });
      expect(composer.getAttribute("contenteditable")).toBe("true");
      expect(router.state.location.pathname).toBe("/chat");
      expect(
        router.state.matches.some(({ routeId }) => routeId === Route.id),
      ).toBe(true);
      expect(caughtErrors).toEqual([]);
      expect(fixture.unexpectedRequests).toEqual([]);
    });
  } finally {
    await fixture.act(async () => {
      fixture.cleanup();
      await queryClient.cancelQueries();
      queryClient.clear();
    });
  }
});
