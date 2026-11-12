#!/usr/bin/env bun
// Guard: every package an app renders that ships Tailwind class names is
// scanned by that app's Tailwind entry.
//
// Tailwind only generates utilities for class names it finds in scanned
// files, and its automatic detection skips node_modules and anything outside
// the app. A dependency that styles its own markup with utilities (streamdown's
// code blocks, @stll/ui's components) therefore renders unstyled, or half
// styled where a class happens to appear elsewhere in the app, until its files
// are named by an `@source`. Nothing fails: the page just looks broken.
//
// A package ships Tailwind classes when it depends on `tailwind-merge`,
// `tailwindcss` or `@stll/ui`. Every such package reachable from an app's
// dependencies, following only through class-shipping packages, needs an
// `@source` whose path lies inside the package.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

const ROOT = path.resolve(import.meta.dir, "..");

const CLASS_SIGNALS = new Set(["tailwind-merge", "tailwindcss", "@stll/ui"]);

// Tailwind's own build and runtime packages depend on `tailwindcss` without
// rendering any markup.
const TAILWIND_TOOLING = new Set([
  "tailwindcss",
  "@tailwindcss/vite",
  "uniwind",
]);

export type TailwindSourceFinding = {
  entry: string;
  dependency: string;
  message: string;
};

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

const readPackageJson = (file: string): PackageJson =>
  JSON.parse(readFileSync(file, "utf-8")) as PackageJson;

const realpathOrSelf = (file: string): string =>
  existsSync(file) ? realpathSync(file) : file;

/** Node resolution of `name`'s package directory, starting at `fromDir`. */
const resolvePackageDir = (
  name: string,
  fromDir: string,
  root: string,
): string | undefined => {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) {
      return realpathSync(path.dirname(candidate));
    }
    if (dir === root || dir === path.dirname(dir)) {
      return undefined;
    }
    dir = path.dirname(dir);
  }
};

const shipsClasses = (pkg: PackageJson): boolean =>
  [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ].some((dep) => CLASS_SIGNALS.has(dep));

/** The absolute directory each `@source` scans, before its first glob. */
export const readSourceRoots = (entryFile: string, css: string): string[] =>
  [...css.matchAll(/^\s*@source\s+(?!not\b)"([^"]+)"/gmu)].map((match) => {
    const segments = (match[1] ?? "").split("/");
    const firstGlob = segments.findIndex((part) => /[*{[]/u.test(part));
    const staticPart =
      firstGlob === -1 ? segments : segments.slice(0, firstGlob);
    return realpathOrSelf(
      path.resolve(path.dirname(entryFile), staticPart.join("/")),
    );
  });

/** Class-shipping packages the app renders, by name and real directory. */
const classShippingPackages = (
  appDir: string,
  root: string,
): Map<string, string> => {
  const found = new Map<string, string>();
  const visit = (pkg: PackageJson, fromDir: string) => {
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (found.has(name) || TAILWIND_TOOLING.has(name)) {
        continue;
      }
      const dir = resolvePackageDir(name, fromDir, root);
      if (dir === undefined) {
        continue;
      }
      const dependency = readPackageJson(path.join(dir, "package.json"));
      if (!shipsClasses(dependency)) {
        continue;
      }
      found.set(name, dir);
      visit(dependency, dir);
    }
  };
  visit(readPackageJson(path.join(appDir, "package.json")), appDir);
  return found;
};

export const findUnscannedClassPackages = (
  entryFile: string,
  root: string,
): TailwindSourceFinding[] => {
  let appDir = path.dirname(entryFile);
  while (!existsSync(path.join(appDir, "package.json"))) {
    appDir = path.dirname(appDir);
  }
  const sourceRoots = readSourceRoots(
    entryFile,
    readFileSync(entryFile, "utf-8"),
  );
  const entry = repoRelativePath(root, entryFile);
  return [...classShippingPackages(appDir, root)]
    .filter(
      ([, dir]) => !sourceRoots.some((source) => isPathInside(dir, source)),
    )
    .map(([dependency]) => ({
      entry,
      dependency,
      message: `${dependency} ships Tailwind class names but no @source in ${entry} scans it, so its markup renders unstyled. Add an @source for its compiled or source files.`,
    }));
};

const tailwindEntries = (root: string): string[] =>
  Bun.spawnSync(["git", "ls-files", "apps/**/*.css"], { cwd: root })
    .stdout.toString()
    .split("\n")
    .filter((file) => file.length > 0)
    .map((file) => path.join(root, file))
    .filter((file) =>
      /^\s*@import\s+["']tailwindcss["']/mu.test(readFileSync(file, "utf-8")),
    );

if (import.meta.main) {
  const findings = tailwindEntries(ROOT).flatMap((entry) =>
    findUnscannedClassPackages(entry, ROOT),
  );
  for (const { entry, dependency, message } of findings) {
    process.stderr.write(`${entry}: ${dependency}: ${message}\n`);
  }
  if (findings.length > 0) {
    process.exitCode = 1;
  } else {
    process.stdout.write(
      "Tailwind sources: every class-shipping dependency is scanned.\n",
    );
  }
}
