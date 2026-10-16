#!/usr/bin/env bun

import { panic } from "better-result";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

import config from "../oxlint.config.ts";

// Measured cold on a cloud runner: 76 s for all five entry points, so one
// entry point can exceed the plugin's 60 s default on a loaded runner. Only
// this one-off warm run gets the wider budget; lint keeps the default and
// reads the warmed cache.
const WARM_TIMEOUT_MS = 300_000;

// oxlint-tailwindcss 1.x keeps its content-hashed design-system cache in
// `<os tmpdir>/oxlint-tailwindcss-<uid>` (`cacheDirName` in its dist) and reads
// no override. CI caches this directory between jobs; the warm run fails if
// the plugin stops writing here, so a plugin upgrade cannot silently turn the
// cache step into a no-op.
export const tailwindCacheDirectory = (): string => {
  const { uid, username } = userInfo();
  const id = uid >= 0 ? String(uid) : username;
  return path.join(
    tmpdir(),
    `oxlint-tailwindcss-${id.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}`,
  );
};

const cachedDesignSystems = (): string[] => {
  const directory = tailwindCacheDirectory();
  return existsSync(directory)
    ? readdirSync(directory).filter((file) => file.endsWith(".json"))
    : [];
};

type TailwindEntryPoint = {
  files: string;
  use: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const extractTailwindEntryPoints = (
  oxlintConfig: unknown,
): TailwindEntryPoint[] => {
  if (!isRecord(oxlintConfig) || !isRecord(oxlintConfig.settings)) {
    panic("oxlint config has no settings object");
  }
  const tailwindcss = oxlintConfig.settings.tailwindcss;
  if (!isRecord(tailwindcss) || !Array.isArray(tailwindcss.entryPoint)) {
    panic("oxlint config has no tailwindcss entryPoint list");
  }

  const distinct = new Map<string, TailwindEntryPoint>();
  for (const value of tailwindcss.entryPoint) {
    if (
      !isRecord(value) ||
      typeof value.files !== "string" ||
      typeof value.use !== "string"
    ) {
      panic("tailwindcss entryPoint rows require files and use");
    }
    if (!distinct.has(value.use)) {
      distinct.set(value.use, { files: value.files, use: value.use });
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
  const cached = cachedDesignSystems().length;
  if (cached < entryPoints.length) {
    panic(
      `Expected ${entryPoints.length} cached design systems in ${tailwindCacheDirectory()}, found ${cached}; the oxlint-tailwindcss cache location changed`,
    );
  }
};

if (import.meta.main) {
  if (process.argv.includes("--cache-dir")) {
    console.log(tailwindCacheDirectory());
  } else {
    warmTailwindDesignSystems();
  }
}
