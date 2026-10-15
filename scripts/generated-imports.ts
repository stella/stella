import path from "node:path";
import ts from "typescript";

import {
  GENERATORS,
  matchesGeneratedGlob,
  type Generator,
} from "./generated-files";

/**
 * A package source may import a generated module only when a fresh export of
 * the package can still compile: the module is tracked, or a script that
 * `npm pack` runs before packing (`prepack`, `prepare`, and anything they
 * reach through `<runner> run <name>`) derives it (a manifest `derived`
 * generator). Anything else compiles in a developer
 * checkout that happens to hold the file and fails in a clean pack.
 */

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs"];
// The lifecycle scripts `npm pack` runs before it packs; `build` counts only
// when one of them reaches it.
const PACK_ROOT_SCRIPTS = ["prepack", "prepare"] as const;
const SCRIPT_RUNNERS = new Set(["bun", "npm", "pnpm", "yarn"]);

export type GeneratedImportInputs = {
  /** Repository-relative tracked paths (`git ls-files`). */
  readonly trackedFiles: readonly string[];
  readonly readSource: (file: string) => string;
  /** `scripts` of a tracked package.json, by package directory. */
  readonly readScripts: (packageDirectory: string) => Record<string, string>;
  readonly generators?: readonly Generator[];
};

export type GeneratedImportViolation = {
  readonly importer: string;
  readonly specifier: string;
  readonly missing: string;
};

export const isPackageSource = (file: string): boolean => {
  const [root, , source] = file.split("/");
  return (
    root === "packages" &&
    source === "src" &&
    SOURCE_EXTENSIONS.includes(path.posix.extname(file)) &&
    !file.endsWith(".d.ts")
  );
};

/** Files a relative specifier can name, in the compiler's lookup order. */
export const specifierCandidates = (
  importer: string,
  specifier: string,
): string[] => {
  const target = path.posix.join(path.posix.dirname(importer), specifier);
  const extension = path.posix.extname(target);
  const stem = target.slice(0, target.length - extension.length);
  switch (extension) {
    case ".js":
      return [`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, target];
    case ".mjs":
      return [`${stem}.mts`, `${stem}.d.mts`, target];
    case ".cjs":
      return [`${stem}.cts`, `${stem}.d.cts`, target];
    default:
      if (
        SOURCE_EXTENSIONS.includes(extension) ||
        extension === ".jsx" ||
        extension === ".json"
      ) {
        return [target];
      }
      // A dot in a module basename does not make it a source extension.
      // Bundler resolution: the file forms, then the directory index forms.
      return [
        `${target}.ts`,
        `${target}.tsx`,
        `${target}.d.ts`,
        `${target}.js`,
        `${target}.jsx`,
        `${target}/index.ts`,
        `${target}/index.tsx`,
        `${target}/index.d.ts`,
        `${target}/index.js`,
        `${target}/index.jsx`,
        target,
      ];
  }
};

const isGeneratedPath = (file: string): boolean =>
  file.split("/").includes("generated");

const owningPackage = (file: string, tracked: ReadonlySet<string>): string => {
  let directory = path.posix.dirname(file);
  while (directory !== "." && !tracked.has(`${directory}/package.json`)) {
    directory = path.posix.dirname(directory);
  }
  return directory;
};

/** Scripts `npm pack` runs before packing, plus what they reach by name. */
export const packScriptClosure = (
  scripts: Record<string, string>,
): Set<string> => {
  const reached = new Set<string>();
  const pending: string[] = PACK_ROOT_SCRIPTS.filter((name) => name in scripts);
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) {
      continue;
    }
    reached.add(name);
    for (const target of runTargets(scripts[name] ?? "")) {
      if (target in scripts) {
        pending.push(target);
      }
    }
  }
  return reached;
};

/**
 * Script names a command line runs through `<runner> run <name>`. Separators
 * may touch a word (`bun run build&& tsc`), so commands are split on them
 * first; a line ending in a dangling operator is a shell syntax error and runs
 * nothing.
 */
export const runTargets = (line: string): string[] => {
  if (/(?:&&|\|\||\|)\s*$/u.test(line)) {
    return [];
  }
  return line.split(/&&|\|\||;|\|/u).flatMap((command) => {
    const words = command.trim().split(/\s+/u);
    const index = words.indexOf("run");
    if (index < 1 || !SCRIPT_RUNNERS.has(words[index - 1] ?? "")) {
      return [];
    }
    const target = words.slice(index + 1).find((word) => !word.startsWith("-"));
    return target === undefined ? [] : [target];
  });
};

/** The package script a generator's write command runs, if it runs one. */
export const generatorPackageScript = (
  write: readonly string[],
): { readonly directory: string; readonly script: string } | null => {
  const [runner, ...rest] = write;
  const cwd = rest.find((arg) => arg.startsWith("--cwd="));
  const runIndex = rest.indexOf("run");
  const script = rest.slice(runIndex + 1).find((arg) => !arg.startsWith("-"));
  if (
    runner !== "bun" ||
    cwd === undefined ||
    runIndex === -1 ||
    script === undefined
  ) {
    return null;
  }
  return { directory: cwd.slice("--cwd=".length), script };
};

export const findUnbuildableGeneratedImports = ({
  trackedFiles,
  readSource,
  readScripts,
  generators = GENERATORS,
}: GeneratedImportInputs): GeneratedImportViolation[] => {
  const tracked = new Set(trackedFiles);
  const declared = (file: string) =>
    generators.some(({ outputs }) =>
      outputs.some((output) => matchesGeneratedGlob(output, file)),
    );
  const closures = new Map<string, Set<string>>();
  const packScripts = (directory: string) => {
    const known = closures.get(directory);
    if (known !== undefined) {
      return known;
    }
    const closure = packScriptClosure(readScripts(directory));
    closures.set(directory, closure);
    return closure;
  };
  const derivedByPack = (file: string, directory: string) =>
    generators.some((generator) => {
      const command = generatorPackageScript(generator.write);
      return (
        generator.outputKind === "derived" &&
        generator.outputs.some((output) =>
          matchesGeneratedGlob(output, file),
        ) &&
        command?.directory === directory &&
        packScripts(directory).has(command.script)
      );
    });

  const violations: GeneratedImportViolation[] = [];
  for (const importer of trackedFiles.filter(isPackageSource)) {
    const directory = owningPackage(importer, tracked);
    const { importedFiles } = ts.preProcessFile(
      readSource(importer),
      true,
      true,
    );
    for (const { fileName: specifier } of importedFiles) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        continue;
      }
      const candidates = specifierCandidates(importer, specifier);
      if (candidates.some((file) => tracked.has(file))) {
        continue;
      }
      const generated = candidates.filter(
        (file) => isGeneratedPath(file) || declared(file),
      );
      const [missing] = generated;
      if (
        missing === undefined ||
        generated.some((file) => derivedByPack(file, directory))
      ) {
        continue;
      }
      violations.push({ importer, specifier, missing });
    }
  }
  return violations;
};

export const formatGeneratedImportViolation = ({
  importer,
  specifier,
  missing,
}: GeneratedImportViolation): string =>
  `${importer} imports "${specifier}", but ${missing} is neither tracked nor derived by its package's prepack/build scripts`;
