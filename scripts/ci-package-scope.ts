import { readFileSync } from "node:fs";
import path from "node:path";

import { GENERATORS } from "./generated-files";
import {
  landingBuildRootInputs,
  landingClosure,
  parseLockfile,
} from "./landing-deploy-scope";
import { readStringLiterals, readTestInputs } from "./test-input-readers";

const ROOT = path.resolve(import.meta.dir, "..");
const GLOBAL =
  /(?:^|\/)(?:package\.json|tsconfig[^/]*|bun\.lockb?|bunfig\.toml|\.npmrc|turbo\.json)$|^(?:patches|\.github)\//u;
const CONTENT =
  /^(?:scripts|apps|packages|\.ai|\.agents|\.claude|\.oxlint-plugins|railway)\/|(?:^|\/)(?:AGENTS|GEMINI|SKILL)\.md$|^docs\/(?:changelog|policies)\//u;
const MARKDOWN = /\.mdx?$/u;
const PROVENANCE = /^(?:\.provenance\.yml$|provenance\/)/u;

const matches = (file: string, pattern: string) =>
  file === pattern || new Bun.Glob(pattern).match(file);

// Astro globs are relative to the loader's base, not the repository root.
// Unknown call shapes retain the broad pattern rather than guessing a base.
const loaderPatterns = (source: string, file: string, target: string) => {
  const patterns: string[] = [];
  let unknown = false;
  const workspace = /^(?:apps|packages)\//u.test(file)
    ? file.split("/").slice(0, 2).join("/")
    : ".";
  readStringLiterals(source, (callee, call) => {
    if (
      callee !== "glob" ||
      !readStringLiterals(call).some(({ value }) => value === target)
    ) {
      return;
    }
    // Only a flat options object with two static properties proves a base.
    // Spreads, expressions, nested options and extra arguments remain broad.
    const forward =
      /^\(\s*\{\s*pattern\s*:\s*(["'])([^"'\\]*?)\1\s*,\s*base\s*:\s*(["'])([^"'\\]*?)\3\s*,?\s*\}\s*\)$/u.exec(
        call,
      );
    const reverse =
      /^\(\s*\{\s*base\s*:\s*(["'])([^"'\\]*?)\1\s*,\s*pattern\s*:\s*(["'])([^"'\\]*?)\3\s*,?\s*\}\s*\)$/u.exec(
        call,
      );
    const pattern = forward?.[2] ?? reverse?.[4];
    const base = forward?.[4] ?? reverse?.[2];
    if (pattern === target && base !== undefined) {
      patterns.push(path.posix.join(workspace, base, target));
    } else {
      unknown = true;
    }
  });
  return !unknown && patterns.length > 0 ? patterns : [target];
};

// Declarations bind the selector to generator and test input owners. Literal
// filesystem reads additionally cover guards that are not workspace test tasks.
const markdownInputs = (root: string) => {
  const patterns = new Set(
    GENERATORS.flatMap(({ inputs, outputs }) => [...inputs, ...outputs]),
  );
  for (const inputs of readTestInputs(root).values()) {
    for (const input of inputs) {
      patterns.add(input);
    }
  }
  const sources = new Bun.Glob(
    "{scripts,apps,packages,.oxlint-plugins,.claude}/**/*.{ts,tsx,js,mjs,cjs}",
  );
  for (const file of sources.scanSync({ cwd: root, onlyFiles: true })) {
    if (
      file
        .split("/")
        .some((part) =>
          ["node_modules", ".cache", "dist", "build"].includes(part),
        )
    ) {
      continue;
    }
    const source = readFileSync(path.join(root, file), "utf-8");
    if (
      !/\b(?:readFile(?:Sync)?|readdir(?:Sync)?|Glob)\b|\bBun\.file\b|\b(?:import|require)\b/u.test(
        source,
      )
    ) {
      continue;
    }
    if (/from\s*["']astro\/loaders["']/u.test(source)) {
      let calls = 0;
      readStringLiterals(source, (callee, call) => {
        if (callee !== "glob") {
          return;
        }
        calls += 1;
        if (
          !readStringLiterals(call).some(({ value }) => MARKDOWN.test(value))
        ) {
          patterns.add("**/*.md");
          patterns.add("**/*.mdx");
        }
      });
      if (calls === 0) {
        patterns.add("**/*.md");
        patterns.add("**/*.mdx");
      }
    }
    for (const { value, callee } of readStringLiterals(source)) {
      const target = value.replace(/^(?:\.\.\/)+/u, "");
      if (
        target === "docs" ||
        (target.startsWith("docs/") &&
          target !== "docs/" &&
          !path.extname(target))
      ) {
        patterns.add(
          target.includes("*") ? target : `${target.replace(/\/$/u, "")}/**`,
        );
      }
      if (
        ["join", "resolve"].includes(callee ?? "") &&
        ["docs", "docs/"].includes(target)
      ) {
        patterns.add("docs/**");
      }
      if (
        MARKDOWN.test(target) &&
        !target.includes("\n") &&
        !target.includes(" ")
      ) {
        const inputs =
          target.startsWith("*") &&
          callee === "glob" &&
          /from\s*["']astro\/loaders["']/u.test(source)
            ? loaderPatterns(source, file, target)
            : [target];
        for (const input of inputs) {
          patterns.add(input);
        }
      }
      if (
        ["readdir", "readdirSync", "Glob"].includes(callee ?? "") &&
        target.startsWith("docs/")
      ) {
        patterns.add(
          target.includes("*") ? target : `${target.replace(/\/$/u, "")}/**`,
        );
      }
    }
  }
  return patterns;
};

type ScopeOptions = { changed: readonly string[]; root?: string };
export const requiresPackageChecks = ({
  changed,
  root = ROOT,
}: ScopeOptions): boolean => {
  try {
    if (
      changed.some(
        (file) =>
          GLOBAL.test(file) ||
          (!PROVENANCE.test(file) &&
            (!MARKDOWN.test(file) || CONTENT.test(file))),
      )
    ) {
      return true;
    }
    const documents = changed.filter((file) => !PROVENANCE.test(file));
    if (documents.length === 0) {
      return false;
    }
    const inputs = markdownInputs(root);
    return documents.some((file) =>
      [...inputs].some((input) => matches(file, input)),
    );
  } catch (error) {
    console.error("Package scope unavailable; running package checks", error);
    return true;
  }
};

export const requiresLandingBuild = ({
  changed,
  root = ROOT,
}: ScopeOptions): boolean => {
  try {
    if (
      changed.some(
        (file) =>
          GLOBAL.test(file) ||
          file === "VERSION" ||
          !/\.(?:[cm]?[jt]sx?|css|scss|html|mdx?|json|ya?ml|svg|png|jpe?g|webp|gif|avif|woff2?|ttf|txt|sql|rs|toml|sh|py|go|astro)$/u.test(
            file,
          ),
      )
    ) {
      return true;
    }
    const lock = parseLockfile(
      Bun.JSONC.parse(readFileSync(path.join(root, "bun.lock"), "utf-8")),
    );
    if (lock === undefined) {
      return true;
    }
    const closure = landingClosure(lock);
    if (closure === undefined) {
      return true;
    }
    for (const directory of closure.workspaceDirectories) {
      const workspace = lock.workspaces[directory];
      if (workspace === undefined) {
        return true;
      }
      for (const kind of ["dependencies", "devDependencies"]) {
        const dependencies = workspace[kind];
        if (dependencies === undefined) {
          continue;
        }
        if (typeof dependencies !== "object" || dependencies === null) {
          return true;
        }
        if (
          Object.keys(dependencies).some(
            (name) => lock.packages[name] === undefined,
          )
        ) {
          return true;
        }
      }
    }
    const turbo: unknown = Bun.JSONC.parse(
      readFileSync(path.join(root, "turbo.json"), "utf-8"),
    );
    const inputs = landingBuildRootInputs(turbo);
    // An absent task/input declaration cannot prove the landing is unaffected.
    if (inputs.length === 0) {
      return true;
    }
    return changed.some(
      (file) =>
        [...closure.workspaceDirectories].some(
          (directory) => file === directory || file.startsWith(`${directory}/`),
        ) || inputs.some((input) => matches(file, input)),
    );
  } catch (error) {
    console.error("Landing scope unavailable; building landing", error);
    return true;
  }
};

if (import.meta.main) {
  const [kind, ...changed] = process.argv.slice(2);
  let required = true;
  if (kind === "--package-checks") {
    required = requiresPackageChecks({ changed });
  } else if (kind === "--landing-build") {
    required = requiresLandingBuild({ changed });
  }
  console.log(String(required));
}
