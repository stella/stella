#!/usr/bin/env bun

import { panic } from "better-result";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import * as v from "valibot";

import config from "../oxlint.config.ts";

// Measured cold on a cloud runner: 76 s for all five entry points, so one
// entry point can exceed the plugin's 60 s default on a loaded runner. Only
// this one-off warm run gets the wider budget; lint keeps the default and
// reads the warmed cache.
const WARM_TIMEOUT_MS = 300_000;

// oxlint-tailwindcss resolves its content-hashed cache directory from
// OXLINT_TAILWINDCSS_CACHE_DIR, falling back to `<os tmpdir>/oxlint-tailwindcss-<uid>`
// (`resolveCacheDir` in its dist). CI sets the variable so actions/cache can
// keep the directory between jobs; the warm run fails when the plugin did not
// write there, so a plugin change cannot silently turn the cache into a no-op.
const tailwindCacheDirectory = (): string => {
  const override = process.env["OXLINT_TAILWINDCSS_CACHE_DIR"]?.trim();
  if (override) {
    return override;
  }
  const { uid, username } = userInfo();
  const id = uid >= 0 ? String(uid) : username;
  return path.join(
    tmpdir(),
    `oxlint-tailwindcss-${id.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}`,
  );
};

const cachedDesignSystems = (): number => {
  const directory = tailwindCacheDirectory();
  return existsSync(directory)
    ? readdirSync(directory).filter((file) =>
        /^[0-9a-f]{32}\.json$/u.test(file),
      ).length
    : 0;
};

type TailwindEntryPoint = {
  files: string;
  use: string;
};

const entryPointSchema = v.object({ files: v.string(), use: v.string() });
const configSchema = v.object({
  settings: v.object({
    tailwindcss: v.object({ entryPoint: v.array(v.unknown()) }),
  }),
});

export const extractTailwindEntryPoints = (
  oxlintConfig: unknown,
): TailwindEntryPoint[] => {
  const parsed = v.safeParse(configSchema, oxlintConfig);
  if (!parsed.success) {
    panic("oxlint config has no tailwindcss entryPoint list");
  }

  const distinct = new Map<string, TailwindEntryPoint>();
  for (const value of parsed.output.settings.tailwindcss.entryPoint) {
    const row = v.safeParse(entryPointSchema, value);
    if (!row.success) {
      panic("tailwindcss entryPoint rows require files and use");
    }
    if (!distinct.has(row.output.use)) {
      distinct.set(row.output.use, row.output);
    }
  }
  return [...distinct.values()];
};

const createLintTarget = (files: string): string => {
  const wildcard = files.search(/[?*[]/u);
  const prefix =
    wildcard === -1 ? path.dirname(files) : files.slice(0, wildcard);
  const directory = prefix.endsWith("/") ? prefix : path.dirname(prefix);
  const target = path.join(directory, `.tailwind-warm-${process.pid}.tsx`);
  writeFileSync(
    target,
    'export const WarmTarget = () => <div className="flex" />;\n',
  );
  return target;
};

export const warmTailwindDesignSystems = (): void => {
  const entryPoints = extractTailwindEntryPoints(config);
  const configPath = path.join(
    process.cwd(),
    `.tailwind-warm-${process.pid}.config.json`,
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      jsPlugins: ["oxlint-tailwindcss"],
      settings: {
        tailwindcss: { entryPoint: entryPoints, timeout: WARM_TIMEOUT_MS },
      },
      rules: { "tailwindcss/no-unknown-classes": "error" },
    }),
  );

  try {
    for (const { files, use } of entryPoints) {
      const target = createLintTarget(files);
      const startedAt = performance.now();
      // oxlint-tailwindcss does not export its precompute API. This derived,
      // minimal config makes oxlint load one real file per distinct entry point;
      // the plugin still owns cache hashing and CSS error reporting.
      const result = Bun.spawnSync(
        ["bun", "--bun", "oxlint", "-c", configPath, "--threads=1", target],
        {
          cwd: process.cwd(),
          stdout: "inherit",
          stderr: "inherit",
          timeout: WARM_TIMEOUT_MS,
        },
      );
      rmSync(target, { force: true });
      if (result.exitCode !== 0) {
        panic(
          `Failed to warm Tailwind design system ${use} (exit ${result.exitCode})`,
        );
      }
      console.log(
        `Warmed ${use} in ${Math.round(performance.now() - startedAt)} ms`,
      );
    }
  } finally {
    rmSync(configPath, { force: true });
  }
  const cached = cachedDesignSystems();
  if (cached < entryPoints.length) {
    panic(
      `Expected ${entryPoints.length} design systems cached in ${tailwindCacheDirectory()} found ${cached}; the oxlint-tailwindcss cache location changed`,
    );
  }
};

if (import.meta.main) {
  warmTailwindDesignSystems();
}
