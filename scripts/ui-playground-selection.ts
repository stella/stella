import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WEB_SOURCE = "apps/web/src";
const SPEC_DIRECTORY = "apps/web/e2e/ui-playground";
const METADATA = `${WEB_SOURCE}/routes/dev/-visual-metadata.ts`;
const REGISTRY = `${WEB_SOURCE}/routes/dev/-visual-registry.tsx`;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".css"];
const IMPORT_CLOSURES = new Map<
  string,
  ReturnType<typeof staticImportClosure>
>();

export type PlaygroundInventory = {
  specs: readonly string[];
  registeredVisuals: ReadonlySet<string>;
  loaderByVisual: ReadonlyMap<string, string>;
  visualsBySpec: ReadonlyMap<string, ReadonlySet<string>>;
  complete: boolean;
};

const normalize = (file: string) =>
  file.replaceAll("\\", "/").replace(/^\.\//u, "");

const importExportTargets = (value: unknown): readonly string[] | undefined => {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const targets: string[] = [];
  for (const condition of ["browser", "import", "default"] as const) {
    if (condition in value) {
      const conditionalTargets = importExportTargets(value[condition]);
      if (conditionalTargets === undefined) {
        return undefined;
      }
      targets.push(...conditionalTargets);
    }
  }
  return targets.length === 0 ? undefined : targets;
};

export const registeredVisualNames = (source: string): ReadonlySet<string> => {
  const body =
    /export const visualRegistry\s*=\s*\{(?<body>[\s\S]*?)\n\}\s*as const/u.exec(
      source,
    )?.groups?.["body"];
  if (body === undefined) {
    return new Set();
  }
  return new Set(
    [...body.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gmu)].map(
      (match) => match[1] ?? match[2] ?? "",
    ),
  );
};

export const visualLoaderModules = (
  source: string,
  registryFile = REGISTRY,
): ReadonlyMap<string, string> => {
  const loaders = new Map<string, string>();
  const entries = source.matchAll(
    /^\s{2}(?:"([^"]+)"|([A-Za-z_$][\w$]*)):\s*\{[\s\S]*?import\("([^"]+)"\)[\s\S]*?^\s{2}\},/gmu,
  );
  for (const match of entries) {
    const name = match[1] ?? match[2];
    const imported = match[3];
    if (name !== undefined && imported !== undefined) {
      loaders.set(
        name,
        path.posix.join(path.posix.dirname(registryFile), imported),
      );
    }
  }
  return loaders;
};

export const specVisualNames = (
  source: string,
  registered: ReadonlySet<string>,
): { names: ReadonlySet<string>; complete: boolean } => {
  const names = new Set<string>();
  for (const match of source.matchAll(/\/dev\?visual=([a-z0-9-]+)["'`]/gu)) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  const dynamic = source.includes("/dev?visual=${");
  const registryCensus =
    dynamic && /Object\.entries\(visualRegistry\)/u.test(source);
  if (registryCensus) {
    for (const name of registered) {
      names.add(name);
    }
  }
  return { names, complete: !dynamic || registryCensus };
};

const sourceCandidate = (
  root: string,
  candidate: string,
): string | undefined => {
  const normalized = normalize(path.posix.normalize(candidate));
  const extension = path.posix.extname(normalized);
  let candidates: string[];
  if (!SOURCE_EXTENSIONS.includes(extension)) {
    candidates = [
      normalized,
      ...SOURCE_EXTENSIONS.map(
        (sourceExtension) => `${normalized}${sourceExtension}`,
      ),
      ...SOURCE_EXTENSIONS.map(
        (sourceExtension) => `${normalized}/index${sourceExtension}`,
      ),
    ];
  } else if (extension === ".js" || extension === ".jsx") {
    candidates = [
      normalized,
      ...SOURCE_EXTENSIONS.map(
        (sourceExtension) =>
          `${normalized.slice(0, -extension.length)}${sourceExtension}`,
      ),
    ];
  } else {
    candidates = [normalized];
  }
  return candidates.find(
    (file) =>
      existsSync(path.join(root, file)) &&
      statSync(path.join(root, file)).isFile(),
  );
};

const resolveImport = (
  imported: string,
  importer: string,
  root: string,
): { files: readonly string[]; internal: boolean; complete: boolean } => {
  const importPath = imported.split("?", 1)[0] ?? imported;
  let candidates: readonly string[] | undefined;
  if (importPath.startsWith(".")) {
    candidates = [path.posix.join(path.posix.dirname(importer), importPath)];
  } else if (importPath.startsWith("@/")) {
    candidates = [`${WEB_SOURCE}/${importPath.slice(2)}`];
  } else {
    const workspace = /^@stll\/([^/]+)(?:\/(.*))?$/u.exec(importPath);
    if (workspace !== null) {
      const packagesDirectory = path.join(root, "packages");
      if (!existsSync(packagesDirectory)) {
        return { files: [], internal: true, complete: false };
      }
      const packageRoot = readdirSync(packagesDirectory, {
        withFileTypes: true,
      })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `packages/${entry.name}`)
        .find((directory) => {
          const manifestFile = path.join(root, directory, "package.json");
          if (!existsSync(manifestFile)) {
            return false;
          }
          const manifest: unknown = JSON.parse(
            readFileSync(manifestFile, "utf-8"),
          );
          return (
            typeof manifest === "object" &&
            manifest !== null &&
            "name" in manifest &&
            manifest.name === `@stll/${workspace[1] ?? ""}`
          );
        });
      if (packageRoot === undefined) {
        const installedManifest = path.join(
          root,
          "node_modules",
          "@stll",
          workspace[1] ?? "",
          "package.json",
        );
        if (existsSync(installedManifest)) {
          return { files: [], internal: false, complete: true };
        }
        return { files: [], internal: true, complete: false };
      }
      const packageJson = path.join(root, packageRoot, "package.json");
      if (existsSync(packageJson)) {
        const manifest: unknown = JSON.parse(
          readFileSync(packageJson, "utf-8"),
        );
        const subpath = workspace[2] === undefined ? "." : `./${workspace[2]}`;
        if (
          typeof manifest === "object" &&
          manifest !== null &&
          "exports" in manifest &&
          typeof manifest.exports === "object" &&
          manifest.exports !== null
        ) {
          const exported = Object.entries(manifest.exports).find(
            ([key]) => key === subpath,
          )?.[1];
          const targets = importExportTargets(exported);
          if (targets === undefined) {
            return { files: [], internal: true, complete: false };
          }
          candidates = targets.map((target) => `${packageRoot}/${target}`);
        }
      }
      candidates ??= [
        `${packageRoot}/src${workspace[2] === undefined ? "/index" : `/${workspace[2]}`}`,
      ];
    }
  }
  if (candidates === undefined) {
    return { files: [], internal: false, complete: true };
  }
  const files = candidates
    .map((candidate) => sourceCandidate(root, candidate))
    .filter((file): file is string => file !== undefined);
  return {
    files,
    internal: true,
    complete: files.length === candidates.length,
  };
};

export const staticImportClosure = (
  entry: string,
  root = REPO_ROOT,
): { files: ReadonlySet<string>; complete: boolean } => {
  const files = new Set<string>();
  const pending = [sourceCandidate(root, entry) ?? normalize(entry)];
  let complete = true;
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) {
      complete = false;
      continue;
    }
    if (file.endsWith(".css")) {
      const source = readFileSync(absolute, "utf-8");
      const imports = [
        ...source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/gu),
      ]
        .map((match) => match[1])
        .filter((imported): imported is string => imported !== undefined);
      for (const imported of imports) {
        const resolved = resolveImport(imported, file, root);
        pending.push(...resolved.files);
        complete &&= resolved.complete;
      }
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/u.test(file)) {
      continue;
    }
    const loader = file.endsWith("x") ? "tsx" : "ts";
    const source = readFileSync(absolute, "utf-8");
    let imports: readonly string[];
    try {
      imports = new Bun.Transpiler({ loader, logLevel: "error" })
        .scanImports(source)
        .map(({ path: imported }) => imported);
    } catch {
      imports = [
        ...source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/gu),
      ]
        .map((match) => match[2])
        .filter((imported): imported is string => imported !== undefined);
    }
    for (const imported of imports) {
      const resolved = resolveImport(imported, file, root);
      pending.push(...resolved.files);
      if (!resolved.complete && resolved.internal) {
        complete = false;
      }
    }
  }
  return { files, complete };
};

export const readPlaygroundInventory = (
  root = REPO_ROOT,
): PlaygroundInventory => {
  const registeredVisuals = registeredVisualNames(
    readFileSync(path.join(root, METADATA), "utf-8"),
  );
  const loaderByVisual = visualLoaderModules(
    readFileSync(path.join(root, REGISTRY), "utf-8"),
  );
  const specs = readdirSync(path.join(root, SPEC_DIRECTORY))
    .filter((file) => file.endsWith(".geometry.spec.ts"))
    .map((file) => `${SPEC_DIRECTORY}/${file}`)
    .toSorted();
  const visualsBySpec = new Map<string, ReadonlySet<string>>();
  let complete =
    registeredVisuals.size > 0 &&
    loaderByVisual.size === registeredVisuals.size;
  for (const spec of specs) {
    const mapping = specVisualNames(
      readFileSync(path.join(root, spec), "utf-8"),
      registeredVisuals,
    );
    visualsBySpec.set(spec, mapping.names);
    complete &&= mapping.complete && mapping.names.size > 0;
    for (const name of mapping.names) {
      complete &&= registeredVisuals.has(name) && loaderByVisual.has(name);
    }
  }
  for (const name of registeredVisuals) {
    complete &&= loaderByVisual.has(name);
  }
  return { specs, registeredVisuals, loaderByVisual, visualsBySpec, complete };
};

export const isSharedPlaygroundHarness = (file: string): boolean => {
  const normalized = normalize(file);
  if (
    normalized === "bun.lock" ||
    normalized.startsWith("patches/") ||
    /^apps\/web\/(?:vite|tailwind|postcss)\.config\.[^/]+$/u.test(normalized) ||
    normalized === "apps/web/index.html" ||
    normalized.startsWith("apps/web/public/") ||
    /^packages\/[^/]+\/package\.json$/u.test(normalized) ||
    normalized === "apps/web/e2e/playwright.ui-playground.config.ts" ||
    normalized === METADATA ||
    normalized === REGISTRY ||
    normalized === "apps/web/src/routes/dev.tsx" ||
    normalized.startsWith("apps/web/e2e/helpers/") ||
    normalized.startsWith("packages/ui/src/styles/")
  ) {
    return true;
  }
  return (
    normalized.startsWith(`${SPEC_DIRECTORY}/`) &&
    !normalized.endsWith(".visual.spec.ts") &&
    !normalized.endsWith(".geometry.spec.ts")
  );
};

export const selectGeometrySpecs = (
  changedFiles: readonly string[],
  root = REPO_ROOT,
): readonly string[] => {
  const inventory = readPlaygroundInventory(root);
  const changed = new Set(changedFiles.map(normalize));
  if (!inventory.complete || [...changed].some(isSharedPlaygroundHarness)) {
    return inventory.specs;
  }
  if (
    ![...changed].some(
      (file) =>
        file.startsWith("apps/web/src/") ||
        /^packages\/[^/]+\/src\//u.test(file) ||
        file.endsWith(".geometry.spec.ts"),
    )
  ) {
    return [];
  }
  const selected = new Set<string>();
  const closures = new Map<string, ReturnType<typeof staticImportClosure>>();
  for (const spec of inventory.specs) {
    if (changed.has(spec)) {
      selected.add(spec);
      continue;
    }
    for (const visual of inventory.visualsBySpec.get(spec) ?? []) {
      const loader = inventory.loaderByVisual.get(visual);
      if (loader === undefined) {
        return inventory.specs;
      }
      const cacheKey = `${root}\0${loader}`;
      const closure =
        closures.get(loader) ??
        IMPORT_CLOSURES.get(cacheKey) ??
        staticImportClosure(loader, root);
      closures.set(loader, closure);
      IMPORT_CLOSURES.set(cacheKey, closure);
      if (!closure.complete) {
        return inventory.specs;
      }
      if ([...changed].some((file) => closure.files.has(file))) {
        selected.add(spec);
        break;
      }
    }
  }
  return [...selected].toSorted();
};

/**
 * What the selection would have cost: for each change set (one line of
 * whitespace-separated paths), how many specs it selects.
 */
export const replaySelection = (
  changeSets: readonly (readonly string[])[],
): { runs: number; selecting: number; meanSpecs: number } => {
  const counts = changeSets.map((files) => selectGeometrySpecs(files).length);
  const selecting = counts.filter((count) => count > 0).length;
  const total = counts.reduce((sum, count) => sum + count, 0);
  return {
    runs: counts.length,
    selecting,
    meanSpecs: counts.length === 0 ? 0 : total / counts.length,
  };
};

if (import.meta.main) {
  const [flag, file] = process.argv.slice(2);
  if (flag === "--replay" && file !== undefined) {
    const changeSets = readFileSync(file, "utf-8")
      .split("\n")
      .map((line) => line.split(/\s+/u).filter((entry) => entry !== ""))
      .filter((files) => files.length > 0);
    console.log(JSON.stringify(replaySelection(changeSets)));
  } else {
    console.log(JSON.stringify(selectGeometrySpecs(process.argv.slice(2))));
  }
}
