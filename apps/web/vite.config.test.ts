import { describe, expect, test } from "bun:test";
import type { ConfigEnv, PluginOption, UserConfig } from "vite";

import config from "./vite.config";

describe("vite config", () => {
  test("includes the expected plugins", async () => {
    const resolvedConfig = resolveConfig("test");
    const plugins = await collectNamedPlugins(resolvedConfig.plugins ?? []);

    expect(plugins.length).toBeGreaterThan(0);

    const pluginNames = plugins.map((plugin) => plugin.name);
    expect(pluginNames).toContain("vite:react-babel");
    expect(pluginNames).toContain("@rolldown/plugin-babel");
  });
});

const resolveConfig = (mode: string): UserConfig => {
  if (typeof config !== "function") {
    return config;
  }

  const env = {
    command: "build",
    isPreview: false,
    isSsrBuild: false,
    mode,
  } satisfies ConfigEnv;

  return config(env);
};

const collectNamedPlugins = async (
  options: PluginOption[],
): Promise<{ name: string }[]> => {
  const plugins: { name: string }[] = [];

  for (const option of options) {
    if (option === false || option === null || option === undefined) {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop -- ordered: plugins are collected in declaration order into a shared array
    const resolved = await option;

    if (Array.isArray(resolved)) {
      // oxlint-disable-next-line no-await-in-loop -- ordered: nested plugins are collected in declaration order into a shared array
      plugins.push(...(await collectNamedPlugins(resolved)));
      continue;
    }

    if (!hasName(resolved)) {
      continue;
    }

    plugins.push(resolved);
  }

  return plugins;
};

const hasName = (value: unknown): value is { name: string } => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("name" in value)) {
    return false;
  }

  return typeof value.name === "string";
};
