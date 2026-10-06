import { readFileSync } from "node:fs";
import path from "node:path";

import { GENERATORS } from "./generated-files";
import {
  landingBuildRootInputs,
  landingClosure,
  parseLockfile,
  workspaceClosure,
} from "./landing-deploy-scope";
import {
  readLiteralCallOptions,
  readStringLiterals,
  readTestInputs,
} from "./test-input-readers";

const ROOT = path.resolve(import.meta.dir, "..");
const GLOBAL =
  /(?:^|\/)(?:package\.json|tsconfig[^/]*|bun\.lockb?|bunfig\.toml|\.npmrc|turbo\.json)$|^(?:patches|\.github)\//u;
const CONTENT =
  /^(?:scripts|apps|packages|\.ai|\.agents|\.claude|\.oxlint-plugins|railway)\/|(?:^|\/)(?:AGENTS|GEMINI|SKILL)\.md$|^docs\/(?:changelog|policies)\//u;
const MARKDOWN = /\.mdx?$/u;
const PROVENANCE = /^(?:\.provenance\.yml$|provenance\/)/u;

const matches = (file: string, pattern: string) =>
  file === pattern || new Bun.Glob(pattern).match(file);

const allMarkdownPatterns = () =>
  ["md", "mdx"].map((extension) => `**/*.${extension}`);

// Bind loader patterns to actual imports; quoted fixture source declares none.
const astroMarkdownInputs = (
  source: string,
  file: string,
): string[] | undefined => {
  const importsAstro =
    source.includes("astro/loaders") &&
    new Bun.Transpiler({
      loader: file.endsWith("tsx") || file.endsWith("jsx") ? "tsx" : "ts",
    })
      .scan(source)
      .imports.some(({ path: imported }) => imported === "astro/loaders");
  if (!importsAstro) {
    return undefined;
  }
  const patterns: string[] = [];
  const workspace = /^(?:apps|packages)\//u.test(file)
    ? file.split("/").slice(0, 2).join("/")
    : ".";
  let calls = 0;
  readStringLiterals(source, (callee, call) => {
    if (callee !== "glob") {
      return;
    }
    calls += 1;
    const options = readLiteralCallOptions(call);
    const pattern = options?.get("pattern");
    const base = options?.get("base");
    if (
      options?.size === 2 &&
      pattern !== undefined &&
      MARKDOWN.test(pattern) &&
      base !== undefined
    ) {
      patterns.push(path.posix.join(workspace, base, pattern));
    } else {
      for (const fallback of allMarkdownPatterns()) {
        patterns.push(fallback);
      }
    }
  });
  if (calls === 0) {
    for (const fallback of allMarkdownPatterns()) {
      patterns.push(fallback);
    }
  }
  return patterns;
};

// Declarations bind the selector to generator and test input owners. Literal
// filesystem reads additionally cover guards that are not workspace test tasks.
const markdownInputs = (root: string) => {
  const patterns = new Set<string>(
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
    const loaderInputs = astroMarkdownInputs(source, file);
    if (loaderInputs !== undefined) {
      for (const input of loaderInputs) {
        patterns.add(input);
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
        !target.includes(" ") &&
        (callee !== "glob" || loaderInputs === undefined)
      ) {
        patterns.add(target);
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

export const requiresDesktopBrowser = ({
  changed,
  root = ROOT,
}: ScopeOptions): boolean => {
  try {
    if (changed.some((file) => GLOBAL.test(file))) {
      return true;
    }
    const lock = parseLockfile(
      Bun.JSONC.parse(readFileSync(path.join(root, "bun.lock"), "utf-8")),
    );
    if (lock === undefined) {
      return true;
    }
    const closure = workspaceClosure(lock, "@stll/desktop");
    if (closure === undefined) {
      return true;
    }
    for (const directory of closure.workspaceDirectories) {
      const workspace = lock.workspaces[directory];
      if (workspace === undefined) {
        return true;
      }
      for (const kind of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        const dependencies = workspace[kind];
        if (dependencies === undefined) {
          continue;
        }
        if (
          typeof dependencies !== "object" ||
          dependencies === null ||
          Array.isArray(dependencies)
        ) {
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
    if (typeof turbo !== "object" || turbo === null || !("tasks" in turbo)) {
      return true;
    }
    const tasks = turbo.tasks;
    if (
      typeof tasks !== "object" ||
      tasks === null ||
      !("@stll/desktop#test:browser" in tasks)
    ) {
      return true;
    }
    const task = tasks["@stll/desktop#test:browser"];
    if (typeof task !== "object" || task === null || !("inputs" in task)) {
      return true;
    }
    const inputs = task.inputs;
    if (
      !Array.isArray(inputs) ||
      inputs.length === 0 ||
      inputs.some((input) => typeof input !== "string")
    ) {
      return true;
    }
    const rootInputs = inputs
      .filter(
        (input): input is string =>
          typeof input === "string" && input.startsWith("$TURBO_ROOT$/"),
      )
      .map((input) => input.slice("$TURBO_ROOT$/".length));
    return changed.some(
      (file) =>
        [...closure.workspaceDirectories].some(
          (directory) => file === directory || file.startsWith(`${directory}/`),
        ) || rootInputs.some((input) => matches(file, input)),
    );
  } catch (error) {
    console.error(
      "Desktop browser scope unavailable; running desktop browsers",
      error,
    );
    return true;
  }
};

if (import.meta.main) {
  const [kind, ...changed] = process.argv.slice(2);
  let required = true;
  if (kind === "--package-checks") {
    required = requiresPackageChecks({ changed });
  } else if (kind === "--desktop-browser") {
    required = requiresDesktopBrowser({ changed });
  } else if (kind === "--landing-build") {
    required = requiresLandingBuild({ changed });
  }
  console.log(String(required));
}
