import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const WEB_SOURCE = "apps/web/src";
const SPEC_DIRECTORY = "apps/web/e2e/ui-playground";
const METADATA = `${WEB_SOURCE}/routes/dev/-visual-metadata.ts`;
const REGISTRY = `${WEB_SOURCE}/routes/dev/-visual-registry.tsx`;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".css"];
// Modules that wrap every playground page: the browser entries, the root
// route and the dev route. A change anywhere in their closure can move any
// visual, so it selects every spec.
const APP_SHELL_ENTRIES = [
  `${WEB_SOURCE}/boot-prefetch-entry.ts`,
  `${WEB_SOURCE}/client.tsx`,
  `${WEB_SOURCE}/router.tsx`,
  `${WEB_SOURCE}/routes/__root.tsx`,
  `${WEB_SOURCE}/routes/dev.tsx`,
];
// Boundary files affect the shell, but following their imports would reach
// every app route or playground loader instead of their owning selection.
const APP_SHELL_BOUNDARY: ReadonlySet<string> = new Set([
  `${WEB_SOURCE}/routeTree.gen.ts`,
  REGISTRY,
]);
const IMPORT_CLOSURES = new Map<
  string,
  ReturnType<typeof staticImportClosure>
>();

export type PlaygroundInventory = {
  specs: readonly string[];
  registeredVisuals: ReadonlySet<string>;
  loaderByVisual: ReadonlyMap<string, readonly string[]>;
  visualsBySpec: ReadonlyMap<string, ReadonlySet<string>>;
  complete: boolean;
};

const EMITTED_SCANNER = new Bun.Transpiler({ loader: "js" });

const normalize = (file: string) =>
  file.replaceAll("\\", "/").replace(/^\.\//u, "");

const importExportTargets = (value: unknown): readonly string[] | undefined => {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const conditions = new Map<string, unknown>(Object.entries(value));
  const targets: string[] = [];
  for (const condition of ["browser", "import", "default"] as const) {
    if (conditions.has(condition)) {
      const conditionalTargets = importExportTargets(conditions.get(condition));
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
    [
      ...body.matchAll(/^[ \t]{2}(?:"([^"]+)"|([A-Za-z_$][\w$]*))[ \t]*:/gmu),
    ].map((match) => match[1] ?? match[2] ?? ""),
  );
};

export const visualLoaderModules = (
  source: string,
  registryFile = REGISTRY,
): ReadonlyMap<string, readonly string[]> => {
  const loaders = new Map<string, readonly string[]>();
  const entries = source.matchAll(
    /^[ \t]{2}(?:"([^"]+)"|([A-Za-z_$][\w$]*)):[ \t]*\{([\s\S]*?)^[ \t]{2}\},/gmu,
  );
  for (const match of entries) {
    const name = match[1] ?? match[2];
    const body = match[3];
    if (name === undefined || body === undefined) {
      continue;
    }
    const imported = [
      ...body.matchAll(/\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/gu),
    ].flatMap((entry) => (entry[2] === undefined ? [] : [entry[2]]));
    // An unknown or computed loader leaves the inventory incomplete. A loader
    // can compose several modules; every one contributes to its geometry.
    if (
      imported.length === 0 ||
      imported.length !== (body.match(/\bimport\s*\(/gu)?.length ?? 0)
    ) {
      continue;
    }
    loaders.set(
      name,
      imported.map((module) =>
        path.posix.join(path.posix.dirname(registryFile), module),
      ),
    );
  }
  return loaders;
};

export const specVisualNames = (
  source: string,
  registered: ReadonlySet<string>,
): { names: ReadonlySet<string>; complete: boolean } => {
  const names = new Set<string>();
  // Other query parameters may come before or after the visual name.
  for (const match of source.matchAll(
    /\/dev\?(?:[^"'`\s]*&)?visual=([a-z0-9-]+)(?=["'`&#])/gu,
  )) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  // A `visual=` not followed by a literal name is computed, whatever builds
  // it (interpolation, concatenation) and whichever parameters precede it.
  // A literal that is concatenated on (`"/dev?visual=a" + suffix`) is
  // computed too: the name it ends with is only a prefix.
  const dynamic =
    /\/dev\?(?:[^"'`\s]*&)?visual=(?![a-z0-9-]+["'`&#])/u.test(source) ||
    /\/dev\?(?:[^"'`\s]*&)?visual=[a-z0-9-]*["'`]\s*\+/u.test(source);
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
  boundary: ReadonlySet<string> = new Set(),
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
      boundary.has(file) ||
      (existsSync(path.join(root, file)) &&
        statSync(path.join(root, file)).isFile()),
  );
};

type WorkspaceManifest = { directory: string; manifest: unknown };

const WORKSPACE_MANIFESTS = new Map<
  string,
  ReadonlyMap<string, WorkspaceManifest> | undefined
>();

/** Workspace packages by name, read once per root: every `@stll/*` import
 *  resolves through this index. */
const workspaceManifests = (
  root: string,
): ReadonlyMap<string, WorkspaceManifest> | undefined => {
  if (WORKSPACE_MANIFESTS.has(root)) {
    return WORKSPACE_MANIFESTS.get(root);
  }
  const packagesDirectory = path.join(root, "packages");
  let manifests: Map<string, WorkspaceManifest> | undefined;
  if (existsSync(packagesDirectory)) {
    manifests = new Map();
    for (const entry of readdirSync(packagesDirectory, {
      withFileTypes: true,
    })) {
      const directory = `packages/${entry.name}`;
      const manifestFile = path.join(root, directory, "package.json");
      if (!entry.isDirectory() || !existsSync(manifestFile)) {
        continue;
      }
      const manifest: unknown = JSON.parse(readFileSync(manifestFile, "utf-8"));
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        "name" in manifest &&
        typeof manifest.name === "string" &&
        !manifests.has(manifest.name)
      ) {
        manifests.set(manifest.name, { directory, manifest });
      }
    }
  }
  WORKSPACE_MANIFESTS.set(root, manifests);
  return manifests;
};

const resolveImport = (
  imported: string,
  importer: string,
  root: string,
  boundary: ReadonlySet<string>,
): { files: readonly string[]; internal: boolean; complete: boolean } => {
  const importPath = imported.split(/[?#]/u, 1)[0] ?? imported;
  let candidates: readonly string[] | undefined;
  if (importPath.startsWith(".")) {
    candidates = [path.posix.join(path.posix.dirname(importer), importPath)];
  } else if (importPath.startsWith("@/")) {
    candidates = [`${WEB_SOURCE}/${importPath.slice(2)}`];
  } else {
    const workspace = /^@stll\/([^/]+)(?:\/(.*))?$/u.exec(importPath);
    if (workspace !== null) {
      const manifests = workspaceManifests(root);
      if (manifests === undefined) {
        return { files: [], internal: true, complete: false };
      }
      const workspacePackage = manifests.get(`@stll/${workspace[1] ?? ""}`);
      if (workspacePackage === undefined) {
        const version = dependencyVersion(
          root,
          importer,
          `@stll/${workspace[1] ?? ""}`,
        );
        if (
          version !== undefined &&
          !/^(?:workspace:|file:|link:|\.{0,2}\/)/u.test(version)
        ) {
          return { files: [], internal: false, complete: true };
        }
        return { files: [], internal: true, complete: false };
      }
      const { directory: packageRoot, manifest } = workspacePackage;
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
      } else if (
        typeof manifest === "object" &&
        manifest !== null &&
        "exports" in manifest
      ) {
        // Any other exports form (a string, an array) names the entry the
        // package really loads: the src/index fallback would guess, so only
        // a plain string root export resolves; everything else fails closed.
        const exported = manifest.exports;
        if (subpath !== "." || typeof exported !== "string") {
          return { files: [], internal: true, complete: false };
        }
        candidates = [`${packageRoot}/${exported.replace(/^\.\//u, "")}`];
      } else if (
        typeof manifest === "object" &&
        manifest !== null &&
        ["main", "module", "browser"].some((field) => field in manifest)
      ) {
        // A declared entry without exports: the src/index convention below
        // would guess past it, so the closure is unknown.
        return { files: [], internal: true, complete: false };
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
    .map((candidate) => sourceCandidate(root, candidate, boundary))
    .filter((file): file is string => file !== undefined);
  return {
    files,
    internal: true,
    complete: files.length === candidates.length,
  };
};

// Planning precedes installation, so package ownership comes from declarations.
const dependencyVersion = (
  root: string,
  file: string,
  name: string,
): string | undefined => {
  for (
    let directory = path.posix.dirname(file);
    ;
    directory = path.posix.dirname(directory)
  ) {
    const manifestPath = path.join(root, directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (typeof manifest !== "object" || manifest === null) {
        return undefined;
      }
      for (const field of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
      ]) {
        const deps: unknown = Reflect.get(manifest, field);
        if (typeof deps !== "object" || deps === null) {
          continue;
        }
        const version: unknown = Reflect.get(deps, name);
        if (typeof version === "string") {
          return version;
        }
      }
      return undefined;
    }
    if (directory === "." || directory === "") {
      return undefined;
    }
  }
};

// The files a stylesheet's `@import`s load, and whether all were resolved.
const stylesheetImports = (
  imports: readonly string[],
  file: string,
  root: string,
  boundary: ReadonlySet<string>,
): { files: string[]; complete: boolean } => {
  const files: string[] = [];
  let complete = true;
  for (const imported of imports) {
    const bare = !/^(?:[./@]|[a-z][a-z0-9+.-]*:)/iu.test(imported);
    // CSS resolves a bare path against the stylesheet first; only a path
    // with no such file is a package (`@import "tailwindcss"`).
    const relative = bare
      ? sourceCandidate(
          root,
          path.posix.join(path.posix.dirname(file), imported),
        )
      : undefined;
    if (relative !== undefined) {
      files.push(relative);
      continue;
    }
    // A bare name that is neither next to the stylesheet nor a dependency its
    // package declares (a deleted or misspelled local stylesheet) leaves the
    // closure unknown rather than reading as an external package. Declared,
    // not installed: planning runs before any install.
    if (
      bare &&
      dependencyVersion(root, file, imported.split("/", 1)[0] ?? imported) ===
        undefined
    ) {
      complete = false;
      continue;
    }
    const resolved = resolveImport(imported, file, root, boundary);
    files.push(...resolved.files);
    complete &&= resolved.complete;
  }
  return { files, complete };
};

export const staticImportClosure = (
  entry: string,
  root = REPO_ROOT,
  boundary: ReadonlySet<string> = new Set(),
): { files: ReadonlySet<string>; complete: boolean } => {
  const files = new Set<string>();
  const pending = [sourceCandidate(root, entry) ?? normalize(entry)];
  let complete = true;
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    if (boundary.has(file)) {
      continue;
    }
    const absolute = path.join(root, file);
    if (!existsSync(absolute)) {
      complete = false;
      continue;
    }
    if (file.endsWith(".css")) {
      const source = readFileSync(absolute, "utf-8");
      const imports = [
        ...source.matchAll(
          /@import\s+(?:url\(\s*["']?([^"')\s]+)["']?\s*\)|["']([^"']+)["'])/gu,
        ),
      ]
        .map((match) => match[1] ?? match[2])
        .filter((imported): imported is string => imported !== undefined)
        // A resource query or hash names the same file (`tokens.css?theme`).
        .map((imported) => imported.split(/[?#]/u, 1)[0] ?? imported);
      const resolved = stylesheetImports(imports, file, root, boundary);
      pending.push(...resolved.files);
      complete &&= resolved.complete;
      // Assets a stylesheet references (`url(./background.svg)`) render with
      // it, so a local one joins the closure; one that cannot be found leaves
      // the closure unknown.
      for (const match of source.matchAll(
        /url\(\s*["']?([^"')\s]+)["']?\s*\)/gu,
      )) {
        const reference = match[1];
        if (
          reference === undefined ||
          /^(?:[a-z][a-z0-9+.-]*:|#|\/)/iu.test(reference)
        ) {
          continue;
        }
        const asset = normalize(
          path.posix.join(
            path.posix.dirname(file),
            reference.split(/[?#]/u)[0] ?? reference,
          ),
        );
        if (existsSync(path.join(root, asset))) {
          pending.push(asset);
        } else if (sourceCandidate(root, asset) === undefined) {
          complete = false;
        }
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
      const transpiler = new Bun.Transpiler({ loader, logLevel: "error" });
      // `scanImports` on JSX throws on warnings the transform only logs (a
      // `key` after a spread), so the imports come from the emitted code.
      const emitted = transpiler.transformSync(source);
      imports = EMITTED_SCANNER.scanImports(emitted).map(
        ({ path: imported }) => imported,
      );
      // A computed `import(...)` names no module the scan can follow. The
      // emitted code has no comments or type-only imports, so any call beyond
      // the literal ones leaves the closure unknown.
      const dynamicCalls = emitted.match(/\bimport\s*\(/gu)?.length ?? 0;
      const literalCalls =
        emitted.match(/\bimport\s*\(\s*(["'])[^"'`]+\1\s*[,)]/gu)?.length ?? 0;
      if (dynamicCalls > literalCalls) {
        complete = false;
      }
    } catch {
      // A file the transpiler cannot parse is followed as far as the plain
      // scan reaches, but its closure is not known to be complete.
      complete = false;
      imports = [
        ...source.matchAll(/(?:from\s*|import\s*\()(["'])([^"']+)\1/gu),
      ]
        .map((match) => match[2])
        .filter((imported): imported is string => imported !== undefined);
    }
    for (const imported of imports) {
      const resolved = resolveImport(imported, file, root, boundary);
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

/** The app shell's import closure; incomplete when any entry is missing or
 *  reaches an internal module the selector cannot resolve. */
export const appShellClosure = (
  root = REPO_ROOT,
): { files: ReadonlySet<string>; complete: boolean } => {
  const files = new Set<string>();
  let complete = true;
  for (const entry of APP_SHELL_ENTRIES) {
    const cacheKey = `${root}\0shell\0${entry}`;
    const closure =
      IMPORT_CLOSURES.get(cacheKey) ??
      staticImportClosure(entry, root, APP_SHELL_BOUNDARY);
    IMPORT_CLOSURES.set(cacheKey, closure);
    complete &&= closure.complete;
    for (const file of closure.files) {
      files.add(file);
    }
  }
  return { files, complete };
};

export const isSharedPlaygroundHarness = (file: string): boolean => {
  const normalized = normalize(file);
  if (
    normalized === "bun.lock" ||
    normalized === "package.json" ||
    normalized === "apps/web/package.json" ||
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
  // A workspace export can point outside `src` (an exported stylesheet), so
  // every package path goes on to the closure check.
  if (
    ![...changed].some(
      (file) =>
        file.startsWith("apps/web/src/") ||
        file.startsWith("packages/") ||
        file.endsWith(".geometry.spec.ts"),
    )
  ) {
    return [];
  }
  // Only source and stylesheet imports are traced. Any other file a page can
  // reach (an image, a font, an asset a stylesheet references with url())
  // is not, so changing one selects every spec.
  if (
    [...changed].some(
      (file) =>
        (file.startsWith(`${WEB_SOURCE}/`) ||
          /^packages\/[^/]+\/src\//u.test(file)) &&
        !SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension)),
    )
  ) {
    return inventory.specs;
  }
  const shell = appShellClosure(root);
  if (!shell.complete || [...changed].some((file) => shell.files.has(file))) {
    return inventory.specs;
  }
  const selected = new Set<string>();
  const closures = new Map<string, ReturnType<typeof staticImportClosure>>();
  for (const spec of inventory.specs) {
    if (changed.has(spec)) {
      selected.add(spec);
      continue;
    }
    for (const visual of inventory.visualsBySpec.get(spec) ?? []) {
      const loaders = inventory.loaderByVisual.get(visual);
      if (loaders === undefined) {
        return inventory.specs;
      }
      for (const loader of loaders) {
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
        }
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
    const changedPaths = process.env["UI_PLAYGROUND_CHANGED_PATHS"];
    const files =
      changedPaths === undefined
        ? process.argv.slice(2)
        : readFileSync(changedPaths, "utf-8").split("\0").filter(Boolean);
    console.log(JSON.stringify(selectGeometrySpecs(files)));
  }
}
