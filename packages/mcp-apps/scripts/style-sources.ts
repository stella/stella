/**
 * The shared UI modules Tailwind scans for the MCP app stylesheet: exactly
 * the ones an MCP app reaches through its imports. Scanning the whole UI
 * packages instead put every class any UI component uses into every app,
 * so an unrelated UI change grew each bundle.
 *
 * `--write` rewrites the generated block of `src/shared/style.css`; without
 * it the block is checked.
 */
import { panic, Result } from "better-result";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import {
  formattedLikeRepository,
  writeOrCheckArtifacts,
} from "../../../scripts/generated-artifacts";
import { MCP_APPS } from "../src/manifest";

/** Packages whose modules carry class names an MCP app renders. */
export const STYLE_SOURCE_ROOTS = [
  "packages/decision-reader/src/",
  "packages/ui/src/",
] as const;
export const STYLE_SOURCES_BEGIN =
  "/* BEGIN GENERATED MCP APP STYLE SOURCES */";
export const STYLE_SOURCES_END = "/* END GENERATED MCP APP STYLE SOURCES */";
export const STYLE_SOURCES_COMMAND =
  "bun packages/mcp-apps/scripts/style-sources.ts --write";

const REPO_ROOT = realpathSync(path.resolve(import.meta.dirname, "../../.."));
const APPS_ROOT = path.join(REPO_ROOT, "packages/mcp-apps/src");
const STYLESHEET = path.join(APPS_ROOT, "shared/style.css");
const MODULE_SCRIPT = /<script type="module" src="\.\/([\w-]+\.tsx)">/gu;
const SCRIPT_MODULE = /\.[cm]?[jt]sx?$/u;
const MARKUP_MODULE = /\.[jt]sx$/u;

/** Whether a repository-relative module is one Tailwind scans for the apps. */
export const isStyleSource = (file: string) =>
  SCRIPT_MODULE.test(file) &&
  STYLE_SOURCE_ROOTS.some((root) => file.startsWith(root));

const loaderOf = (file: string): Bun.JavaScriptLoader => {
  if (file.endsWith(".tsx")) {
    return "tsx";
  }
  if (file.endsWith(".jsx")) {
    return "jsx";
  }
  return /\.[cm]?ts$/u.test(file) ? "ts" : "js";
};

/** The module script each MCP app page loads. */
export const mcpAppEntries = (appsRoot = APPS_ROOT) =>
  MCP_APPS.map(({ directory }) => {
    const page = readFileSync(path.join(appsRoot, directory, "app.html"), {
      encoding: "utf-8",
    });
    const scripts = [...page.matchAll(MODULE_SCRIPT)];
    const script = scripts.at(0)?.[1];
    if (scripts.length !== 1 || script === undefined) {
      panic(`MCP app ${directory} must load exactly one module script`);
    }
    return path.join(appsRoot, directory, script);
  });

/**
 * Every style source module the entries reach, following each runtime
 * import through the repository's workspace packages. Type-only imports add
 * no code and are skipped; generated build outputs do not exist yet and
 * carry no class names.
 */
export const reachedStyleSources = ({
  repoRoot = REPO_ROOT,
  entries,
}: {
  repoRoot?: string;
  entries: readonly string[];
}): string[] => {
  const root = realpathSync(repoRoot);
  const transpilers = new Map<Bun.JavaScriptLoader, Bun.Transpiler>();
  const transpiler = (file: string) => {
    const loader = loaderOf(file);
    const known = transpilers.get(loader);
    if (known !== undefined) {
      return known;
    }
    const created = new Bun.Transpiler({ loader });
    transpilers.set(loader, created);
    return created;
  };
  const visited = new Set<string>();
  const pending = entries.map((file) => realpathSync(file));
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (visited.has(file) || !SCRIPT_MODULE.test(file)) {
      continue;
    }
    visited.add(file);
    const relative = repoRelativePath(root, file);
    if (
      MARKUP_MODULE.test(relative) &&
      !isStyleSource(relative) &&
      !relative.startsWith("packages/mcp-apps/")
    ) {
      panic(
        `MCP apps render ${relative}, outside the scanned style roots ${STYLE_SOURCE_ROOTS.join(", ")}`,
      );
    }
    const directory = path.dirname(file);
    for (const { path: specifier } of transpiler(file).scanImports(
      readFileSync(file, "utf-8"),
    )) {
      const resolved = Result.try(() =>
        realpathSync(Bun.resolveSync(specifier, directory)),
      );
      if (resolved.isOk()) {
        const target = resolved.value;
        if (isPathInside(root, target) && !target.includes("/node_modules/")) {
          pending.push(target);
        }
      } else if (
        !specifier.startsWith("node:") &&
        !(specifier.startsWith(".") && specifier.includes("/generated/"))
      ) {
        panic(`${relative} imports ${specifier}, which does not resolve`);
      }
    }
  }
  return [...visited]
    .map((file) => repoRelativePath(root, file))
    .filter(isStyleSource)
    .toSorted();
};

/** The `@source` rules for the reached modules, relative to the stylesheet. */
export const renderStyleSources = (
  files: readonly string[],
  stylesheetDirectory = "packages/mcp-apps/src/shared",
) =>
  files
    .map(
      (file) =>
        `@source ${JSON.stringify(repoRelativePath(stylesheetDirectory, file, path.posix))};`,
    )
    .join("\n");

const blockBounds = (css: string) => {
  const start = css.indexOf(STYLE_SOURCES_BEGIN);
  const finish = css.indexOf(STYLE_SOURCES_END);
  if (
    start === -1 ||
    finish <= start ||
    css.includes(STYLE_SOURCES_BEGIN, start + STYLE_SOURCES_BEGIN.length) ||
    css.includes(STYLE_SOURCES_END, finish + STYLE_SOURCES_END.length)
  ) {
    panic("The MCP app stylesheet needs exactly one generated sources block");
  }
  return { start: start + STYLE_SOURCES_BEGIN.length, finish };
};

/** The repository-relative modules the stylesheet's generated block scans. */
export const declaredStyleSources = (
  css: string,
  stylesheetDirectory = "packages/mcp-apps/src/shared",
) => {
  const { start, finish } = blockBounds(css);
  return css
    .slice(start, finish)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const source = /^@source "([^"]+)";$/u.exec(line)?.[1];
      if (source === undefined) {
        panic(`Unexpected line in the generated style sources: ${line}`);
      }
      return path.posix.join(stylesheetDirectory, source);
    });
};

/** The stylesheet with its generated block holding exactly `files`. */
export const withStyleSources = (css: string, files: readonly string[]) => {
  const { start, finish } = blockBounds(css);
  return `${css.slice(0, start)}\n${renderStyleSources(files)}\n${css.slice(finish)}`;
};

/**
 * The style source modules among a build's inputs (repository-relative)
 * that the stylesheet does not scan: their class names would be missing.
 */
export const unscannedStyleSources = (
  inputs: readonly string[],
  css: string,
) => {
  const declared = new Set(declaredStyleSources(css));
  return [
    ...new Set(
      inputs.filter((file) => isStyleSource(file) && !declared.has(file)),
    ),
  ].toSorted();
};

if (import.meta.main) {
  const css = readFileSync(STYLESHEET, "utf-8");
  const files = reachedStyleSources({ entries: mcpAppEntries() });
  process.exitCode = await writeOrCheckArtifacts(
    [
      {
        path: STYLESHEET,
        contents: await formattedLikeRepository(
          withStyleSources(css, files),
          "css",
        ),
      },
    ],
    {
      write: process.argv.includes("--write"),
      matched: "the modules MCP apps import",
    },
  );
}
