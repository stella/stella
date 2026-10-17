import { Result } from "better-result";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "@stll/portable-path";

import { HANDLERS_GLOB } from "../apps/api/scripts/lib/enumerate-safe-handlers";
import { analyzeModule } from "./api-test-impact";
import { commandEntries } from "./docker-source-closure";
import {
  GENERATORS,
  matchesGeneratedGlob,
  prerequisiteBuilds,
  type Generator,
} from "./generated-files";

const ROOT = realpathSync(path.join(import.meta.dirname, ".."));
const TRACKED = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT })
  .stdout.toString()
  .split("\0")
  .filter(Boolean);
const MODULE_PATTERN = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const COMPUTED_IMPORT_TARGETS = new Map([
  ["packages/start-runtime/src/local-module-loader.ts", [HANDLERS_GLOB]],
  ["scripts/ownership-loader.ts", ["scripts/ownership/*.ts"]],
]);

const DERIVED = GENERATORS.filter(({ outputKind }) => outputKind === "derived");

const derivedOwner = (file: string) =>
  DERIVED.find(({ outputs }) =>
    outputs.some((output) =>
      matchesGeneratedGlob(output, repoRelativePath(ROOT, file)),
    ),
  );

const realPath = (file: string): string =>
  existsSync(file)
    ? realpathSync(file)
    : path.join(realPath(path.dirname(file)), path.basename(file));

const UNBUILT_HOST: ts.ModuleResolutionHost = {
  fileExists: (file) =>
    ts.sys.fileExists(file) || derivedOwner(realPath(file)) !== undefined,
  readFile: ts.sys.readFile,
  directoryExists: () => true,
  realpath: realPath,
};

const compilerOptions = new Map<string, ts.CompilerOptions>();
const optionsFor = (importer: string) => {
  const config =
    ts.findConfigFile(path.dirname(importer), ts.sys.fileExists) ??
    path.join(ROOT, "tsconfig.json");
  const known = compilerOptions.get(config);
  if (known !== undefined) {
    return known;
  }
  const { options } = ts.parseJsonConfigFileContent(
    ts.readConfigFile(config, ts.sys.readFile).config,
    { ...ts.sys, readDirectory: () => [] },
    path.dirname(config),
  );
  compilerOptions.set(config, options);
  return options;
};

const resolveImport = (specifier: string, importer: string) => {
  const resolved = Result.try(() =>
    Bun.resolveSync(specifier, path.dirname(importer)),
  );
  if (resolved.isOk()) {
    return resolved.value;
  }
  return ts.resolveModuleName(
    specifier,
    importer,
    optionsFor(importer),
    UNBUILT_HOST,
  ).resolvedModule?.resolvedFileName;
};

type ModuleImports = {
  modules: string[];
  derivedOwners: string[];
  unresolved: string[];
  computed: boolean;
};

const moduleImports = new Map<string, ModuleImports>();
const importsOf = (file: string): ModuleImports => {
  const known = moduleImports.get(file);
  if (known !== undefined) {
    return known;
  }
  const analysis = analyzeModule(file, readFileSync(file, "utf-8"));
  const found: ModuleImports = {
    modules: [],
    derivedOwners: [],
    unresolved: [],
    computed: analysis.computedImports,
  };
  for (const { path: specifier } of analysis.imports) {
    if (
      isBuiltin(specifier) ||
      specifier === "bun" ||
      specifier.startsWith("bun:")
    ) {
      continue;
    }
    const resolved = resolveImport(specifier, file);
    if (resolved === undefined) {
      found.unresolved.push(specifier);
      continue;
    }
    if (!path.isAbsolute(resolved)) {
      continue;
    }
    const target = realPath(resolved);
    const owner = derivedOwner(target);
    if (owner !== undefined) {
      found.derivedOwners.push(owner.id);
      continue;
    }
    if (
      target.startsWith(`${ROOT}/`) &&
      !target.includes("/node_modules/") &&
      MODULE_PATTERN.test(target)
    ) {
      found.modules.push(target);
    }
  }
  moduleImports.set(file, found);
  return found;
};

const computedTargets = (file: string): string[] => {
  const globs = COMPUTED_IMPORT_TARGETS.get(repoRelativePath(ROOT, file)) ?? [];
  return TRACKED.filter(
    (tracked) =>
      !tracked.endsWith(".test.ts") &&
      globs.some((glob) => matchesGeneratedGlob(glob, tracked)),
  ).map((tracked) => path.join(ROOT, tracked));
};

const SOURCE_TREE = new Map(TRACKED.map((file) => [`/app/${file}`, file]));

const commandModules = (generator: Generator) =>
  [
    generator.write,
    ...(generator.check === null ? [] : [generator.check]),
    ...(generator.prepare === undefined ? [] : [generator.prepare]),
  ].flatMap((command) =>
    commandEntries(ROOT, SOURCE_TREE, command.join(" "), "/app").map((file) =>
      path.join(ROOT, file.slice("/app/".length)),
    ),
  );

type GeneratorReach = {
  derivedOwners: Set<string>;
  unresolved: string[];
  unlistedComputedImports: string[];
};

const reachOf = (generator: Generator): GeneratorReach => {
  const reach: GeneratorReach = {
    derivedOwners: new Set(),
    unresolved: [],
    unlistedComputedImports: [],
  };
  const seen = new Set<string>();
  const pending = commandModules(generator);
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const imports = importsOf(file);
    for (const owner of imports.derivedOwners) {
      reach.derivedOwners.add(owner);
    }
    for (const specifier of imports.unresolved) {
      reach.unresolved.push(`${repoRelativePath(ROOT, file)}: ${specifier}`);
    }
    if (imports.computed && computedTargets(file).length === 0) {
      reach.unlistedComputedImports.push(repoRelativePath(ROOT, file));
    }
    pending.push(...imports.modules, ...computedTargets(file));
  }
  return reach;
};

const PLANNED = GENERATORS.filter(
  (generator) =>
    generator.autofix ||
    GENERATORS.some(({ prerequisites }) =>
      prerequisites?.some((id) => id === generator.id),
    ),
);

test.each(PLANNED.map((generator) => [generator.id, generator] as const))(
  "%s declares every derived output its commands import",
  (_id, generator) => {
    const reach = reachOf(generator);
    expect(reach.unresolved).toEqual([]);
    expect(reach.unlistedComputedImports).toEqual([]);
    reach.derivedOwners.delete(generator.id);
    expect([...(generator.prerequisites ?? [])].toSorted()).toEqual(
      [...reach.derivedOwners].toSorted(),
    );
  },
);

test("prerequisite builds come before every generator that needs them", () => {
  for (const generator of GENERATORS) {
    const builds = prerequisiteBuilds([generator]);
    const ids = builds.map(({ id }) => id);
    expect(new Set(ids).size, generator.id).toBe(ids.length);
    for (const id of generator.prerequisites ?? []) {
      expect(ids, generator.id).toContain(id);
    }
    for (const [index, build] of builds.entries()) {
      for (const id of build.prerequisites ?? []) {
        expect(ids.indexOf(id), `${generator.id}: ${build.id}`).not.toBe(-1);
        expect(ids.indexOf(id), `${generator.id}: ${build.id}`).toBeLessThan(
          index,
        );
      }
    }
  }
});
