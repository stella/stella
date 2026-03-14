import { describe, expect, test } from "bun:test";
import { resolveConfig } from "vite";

describe("vite config", () => {
  test("resolves with plugins loaded", async () => {
    const config = await resolveConfig(
      { configFile: `${import.meta.dirname}/vite.config.ts` },
      "build",
    );

    expect(config.plugins.length).toBeGreaterThan(0);

    const pluginNames = config.plugins.map((p) => p.name);
    expect(pluginNames).toContain("vite:react-babel");
    expect(pluginNames).toContain("@rolldown/plugin-babel");
  });
});
