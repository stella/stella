import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

describe("version refresh route boundary", () => {
  test("keeps the refresh provider mounted above the root outlet", async () => {
    const rootRoutePath = nodePath.resolve(
      import.meta.dir,
      "../routes/__root.tsx",
    );
    const rootRouteSource = await Bun.file(rootRoutePath).text();

    expect(rootRouteSource).toMatch(
      /<ApiVersionMismatchProvider>\s*<AppFrameHost>\s*<Outlet \/>\s*<\/AppFrameHost>/u,
    );
  });

  test("keeps root-route errors inside the application providers", async () => {
    const rootRoutePath = nodePath.resolve(
      import.meta.dir,
      "../routes/__root.tsx",
    );
    const rootRouteSource = await Bun.file(rootRoutePath).text();

    expect(rootRouteSource).toContain("errorComponent: RootErrorComponent");
    expect(rootRouteSource).toMatch(
      /function RootErrorComponent[\s\S]*?<AppProviders[\s\S]*?<DefaultErrorComponent[\s\S]*?<\/AppProviders>[\s\S]*?\n\}\n\nfunction RootComponent/u,
    );
  });
});

test("keeps root-route not-found translations inside the application providers", async () => {
  const rootRouteSource = await Bun.file(
    nodePath.resolve(import.meta.dir, "../routes/__root.tsx"),
  ).text();
  expect(rootRouteSource).toContain("notFoundComponent: RootNotFoundComponent");
  expect(rootRouteSource).toMatch(
    /function RootNotFoundComponent[\s\S]*?<AppProviders[\s\S]*?<DefaultNotFoundComponent \/>[\s\S]*?<\/AppProviders>/u,
  );
});
