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
      /<ApiVersionMismatchProvider>\s*<Outlet \/>/u,
    );
  });
});
