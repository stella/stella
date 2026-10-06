import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import {
  readStringLiterals,
  readTestInputs,
} from "./check-test-input-coverage";
import { GENERATORS } from "./generated-files";
import {
  landingBuildRootInputs,
  landingClosure,
  parseLockfile,
} from "./landing-deploy-scope";

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
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const patterns: string[] = [];
  let unknown = false;
  const workspace = /^(?:apps|packages)\//u.test(file)
    ? file.split("/").slice(0, 2).join("/")
    : ".";
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "glob") {
      const literals = readStringLiterals(node.getText(tree));
      if (literals.some(({ value }) => value === target)) {
        const options = node.arguments[0];
        const properties =
          options && ts.isObjectLiteralExpression(options)
            ? options.properties.filter(ts.isPropertyAssignment)
            : [];
        const pattern = properties.find(
          (property) => property.name.getText(tree) === "pattern",
        )?.initializer;
        const base = properties.find(
          (property) => property.name.getText(tree) === "base",
        )?.initializer;
        if (
          pattern &&
          ts.isStringLiteral(pattern) &&
          pattern.text === target &&
          base &&
          ts.isStringLiteral(base)
        ) {
          patterns.push(path.posix.join(workspace, base.text, target));
        } else {
          unknown = true;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
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
