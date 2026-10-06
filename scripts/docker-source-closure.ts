import { panic } from "better-result";
import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import ts from "typescript";
import * as v from "valibot";

import { GENERATORS, type Generator } from "./generated-files";
import { specifierCandidates } from "./generated-imports";
import { lexShell } from "./install-free-ci";

// Container paths map to checkout paths. Resolution never falls back from
// this inventory to the checkout.
export type SourceTree = Map<string, string>;
const modulePattern = /\.(?:[cm]?[jt]sx?)$/u;
const absolute = (cwd: string, file: string) => path.posix.resolve(cwd, file);
const sourceCache = new Map<string, string>();
const text = (root: string, file: string) => {
  const key = path.join(root, file);
  let source = sourceCache.get(key);
  if (source === undefined) {
    source = readFileSync(key, "utf-8");
    sourceCache.set(key, source);
  }
  return source;
};

export const dockerInstructions = (source: string): string[] => {
  if (
    source.split(/\r?\n/u).some((line) => {
      const trimmed = line.trimStart();
      return (
        (/^(?:RUN|COPY)\s/iu.test(trimmed) && trimmed.includes("<<")) ||
        /^#\s*escape=/iu.test(trimmed)
      );
    })
  ) {
    panic("Unsupported Docker heredoc or escape directive");
  }
  return source
    .split(/\r?\n/u)
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n")
    .replace(/\\\n/gu, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => line.replace(/^\w+/u, (keyword) => keyword.toUpperCase()));
};

type IgnoreRules = {
  rules: { include: boolean; glob: Bun.Glob }[];
  files: Map<string, boolean>;
};
const ignoreCache = new Map<string, IgnoreRules>();
export const inDockerContext = (file: string, source: string): boolean => {
  let parsed = ignoreCache.get(source);
  if (parsed === undefined) {
    const rules: IgnoreRules["rules"] = [];
    for (let pattern of source.split(/\r?\n/u)) {
      pattern = pattern.trim();
      if (pattern === "" || pattern.startsWith("#")) {
        continue;
      }
      const include = pattern.startsWith("!");
      if (include) {
        pattern = pattern.slice(1);
      }
      let end = pattern.length;
      while (pattern.at(end - 1) === "/" && end > 0) {
        end -= 1;
      }
      pattern = pattern.slice(0, end).replace(/^\/+/u, "");
      if (pattern !== ".") {
        rules.push({ include, glob: new Bun.Glob(pattern) });
      }
    }
    parsed = { rules, files: new Map() };
    ignoreCache.set(source, parsed);
  }
  const cached = parsed.files.get(file);
  if (cached !== undefined) {
    return cached;
  }
  const segments = file.split("/");
  const ancestors = segments.map((_, index) =>
    segments.slice(0, index + 1).join("/"),
  );
  let included = true;
  for (const { include, glob } of parsed.rules) {
    if (ancestors.some((ancestor) => glob.match(ancestor))) {
      included = include;
    }
  }
  parsed.files.set(file, included);
  return included;
};

const filesBelow = (directory: string): string[] => {
  const files: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const file = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (entry.isFile()) {
        files.push(file);
      } else {
        panic(`Unsupported source symlink: ${file}`);
      }
    }
  };
  walk("");
  return files;
};

const hasDirectory = (files: SourceTree, directory: string) => {
  const prefix = `${directory.replace(/\/$/u, "")}/`;
  for (const file of files.keys()) {
    if (file.startsWith(prefix)) {
      return true;
    }
  }
  return false;
};

export const copySource = (
  source: SourceTree,
  destination: SourceTree,
  from: string,
  to: string,
) => {
  const exact = source.get(from);
  if (exact !== undefined) {
    destination.set(
      to.endsWith("/") || hasDirectory(destination, to)
        ? path.posix.join(to, path.posix.basename(from))
        : to,
      exact,
    );
    return;
  }
  const prefix = `${from.replace(/\/$/u, "")}/`;
  const matches = [...source].filter(([file]) => file.startsWith(prefix));
  if (matches.length === 0) {
    panic(`COPY source is unavailable: ${from}`);
  }
  for (const [file, origin] of matches) {
    destination.set(path.posix.join(to, file.slice(prefix.length)), origin);
  }
};

const runtimeImports = (file: string, source: string): string[] => {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
  );
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (
        !node.importClause?.name &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((item) => item.isTypeOnly)
      ) {
        return;
      }
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length > 0 &&
        node.exportClause.elements.every((item) => item.isTypeOnly)
      ) {
        return;
      }
      imports.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (
        argument !== undefined &&
        (ts.isStringLiteral(argument) ||
          ts.isNoSubstitutionTemplateLiteral(argument))
      ) {
        imports.push(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return imports;
};

const configurationOptions = (
  root: string,
  tree: SourceTree,
  physical: (file: string) => string,
) => {
  const optionCache = new Map<string, ts.CompilerOptions>();
  const configCache = new Map<string, Record<string, string[]>>();
  const configPaths = (
    file: string,
    active = new Set<string>(),
  ): Record<string, string[]> => {
    const key = physical(file);
    const cached = configCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (active.has(key)) {
      panic(`Recursive tsconfig: ${key}`);
    }
    active.add(key);
    const origin = tree.get(key);
    if (origin === undefined) {
      // Bun runtime and bundling tolerate missing inherited configuration.
      active.delete(key);
      return {};
    }
    const parsed = ts.parseConfigFileTextToJson(origin, text(root, origin));
    if (parsed.error) {
      panic(`Invalid tsconfig: ${origin}`);
    }
    const directory = path.posix.dirname(key);
    const config = v.parse(
      v.looseObject({
        extends: v.optional(v.string()),
        compilerOptions: v.optional(
          v.looseObject({
            baseUrl: v.optional(v.string()),
            paths: v.optional(v.record(v.string(), v.array(v.string()))),
          }),
        ),
      }),
      parsed.config,
    );
    const parent = config.extends;
    const inherited =
      parent === undefined
        ? {}
        : configPaths(
            parent.startsWith(".")
              ? absolute(directory, parent)
              : `/app/node_modules/${parent}`,
            active,
          );
    const options = config.compilerOptions ?? {};
    const paths: Record<string, string[]> =
      options.paths === undefined
        ? inherited
        : Object.fromEntries(
            Object.entries(options.paths).map(([pattern, targets]) => [
              pattern,
              targets.map((target) =>
                absolute(absolute(directory, options.baseUrl ?? "."), target),
              ),
            ]),
          );
    active.delete(key);
    configCache.set(key, paths);
    return paths;
  };
  const optionsFor = (file: string): ts.CompilerOptions => {
    const cached = optionCache.get(path.posix.dirname(file));
    if (cached !== undefined) {
      return cached;
    }
    let directory = path.posix.dirname(file);
    const result: ts.CompilerOptions = {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.Preserve,
      resolveJsonModule: true,
      allowJs: true,
      customConditions: ["bun", "source"],
    };
    while (directory !== "/") {
      if (tree.has(`${directory}/tsconfig.json`)) {
        result.paths = configPaths(`${directory}/tsconfig.json`);
        break;
      }
      directory = path.posix.dirname(directory);
    }
    optionCache.set(path.posix.dirname(file), result);
    return result;
  };
  return optionsFor;
};

// Follow literal runtime imports (type-only imports vanish).
// TypeScript resolves aliases and workspace exports against the virtual tree.
const sourceClosureChecker = (root: string, tree: SourceTree) => {
  const manifests = [...tree].filter(([file]) =>
    /^\/app\/(?:apps|packages)\/[^/]+\/package\.json$/u.test(file),
  );
  const workspaces = new Map(
    manifests.map(([file, origin]) => {
      const manifest = v.parse(
        v.object({ name: v.string() }),
        JSON.parse(text(root, origin)),
      );
      return [manifest.name, path.posix.dirname(file)];
    }),
  );
  const lockfile = tree.get("/app/bun.lock");
  if (typeof lockfile === "string") {
    const parsed = ts.parseConfigFileTextToJson(lockfile, text(root, lockfile));
    if (parsed.error) {
      panic("Invalid Bun lockfile");
    }
    workspaces.clear();
    for (const [name, entry] of Object.entries(parsed.config.packages ?? {})) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") {
        panic(`Invalid lock resolution: ${name}`);
      }
      const marker = entry[0].indexOf("@workspace:");
      if (
        marker !== -1 &&
        name.startsWith("@stll/") &&
        name.split("/").length === 2
      ) {
        workspaces.set(
          name,
          `/app/${entry[0].slice(marker + "@workspace:".length)}`,
        );
      }
    }
  }
  const physical = (file: string) => {
    const prefix = "/app/node_modules/";
    if (!file.startsWith(prefix)) {
      return file;
    }
    const suffix = file.slice(prefix.length);
    const parts = suffix.split("/");
    const name = parts.at(0)?.startsWith("@")
      ? parts.slice(0, 2).join("/")
      : parts.at(0);
    const workspace = workspaces.get(name ?? "");
    return workspace === undefined
      ? file
      : workspace + suffix.slice(name?.length ?? 0);
  };
  const sourceAvailable = (file: string) =>
    !/\.d\.[cm]?ts$/u.test(file) && tree.has(physical(file));
  const host: ts.ModuleResolutionHost = {
    getCurrentDirectory: () => "/app",
    fileExists: sourceAvailable,
    readFile: (file) => {
      const origin = tree.get(physical(file));
      return typeof origin === "string" ? text(root, origin) : undefined;
    },
    // No directoryExists: TypeScript probes virtual files directly.
  };
  const optionsFor = configurationOptions(root, tree, physical);
  return (entries: readonly string[], seen = new Set<string>()): string[] => {
    const problems: string[] = [];
    const pending = [...entries];
    while (pending.length > 0) {
      const file = pending.pop();
      if (file === undefined || seen.has(file)) {
        continue;
      }
      seen.add(file);
      const origin = tree.get(file);
      if (!tree.has(file)) {
        problems.push(`Entry is unavailable: ${file}`);
        continue;
      }
      if (origin === undefined || !modulePattern.test(file)) {
        continue;
      }
      const imports = runtimeImports(file, text(root, origin));
      for (const specifier of imports) {
        const clean = specifier.replace(
          /\?(?:raw|url|worker|sharedworker)(?:&(?:raw|url|worker|sharedworker))*$/u,
          "",
        );
        if (clean.startsWith(".")) {
          const resolved = specifierCandidates(file, clean).find(
            sourceAvailable,
          );
          if (resolved === undefined) {
            problems.push(
              `${origin} imports ${specifier}, unavailable in Docker stage`,
            );
          } else {
            pending.push(resolved);
          }
          continue;
        }
        const options = optionsFor(file);
        const aliases = Object.entries(options.paths ?? {}).filter(
          ([pattern]) => {
            const [prefix = "", suffix = ""] = pattern.split("*");
            return pattern.includes("*")
              ? clean.length >= prefix.length + suffix.length &&
                  clean.startsWith(prefix) &&
                  clean.endsWith(suffix)
              : clean === pattern;
          },
        );
        // TypeScript gives exact keys priority, then the longest wildcard prefix.
        aliases.sort(
          ([left], [right]) =>
            Number(left.includes("*")) - Number(right.includes("*")) ||
            right.indexOf("*") - left.indexOf("*"),
        );
        const aliasTargets = aliases
          .slice(0, 1)
          .flatMap(([pattern, targets]) => {
            const [prefix, suffix] = pattern.split("*");
            const wildcard = pattern.includes("*");
            const middle = wildcard
              ? clean.slice(
                  (prefix ?? "").length,
                  suffix === "" || suffix === undefined
                    ? undefined
                    : -suffix.length,
                )
              : "";
            return targets.flatMap((target) =>
              specifierCandidates(
                "/entry.ts",
                absolute(
                  "/app",
                  target.replace("*", () => middle),
                ),
              ),
            );
          });
        // Match every declared alias before excluding installed dependencies:
        // an omitted alias target must still fail the source closure.
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];
        const local =
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          specifier.startsWith("@/") ||
          workspaces.has(name ?? "") ||
          aliases.length > 0;
        if (!local) {
          continue;
        }
        const resolved =
          aliasTargets.find(sourceAvailable) ??
          ts.resolveModuleName(clean, file, options, host).resolvedModule
            ?.resolvedFileName;
        if (resolved === undefined) {
          problems.push(
            `${origin} imports ${specifier}, unavailable in Docker stage`,
          );
        } else {
          pending.push(physical(resolved));
        }
      }
    }
    return problems;
  };
};

export const sourceClosureProblems = (
  root: string,
  tree: SourceTree,
  entries: readonly string[],
  seen = new Set<string>(),
): string[] => sourceClosureChecker(root, tree)(entries, seen);

type Stage = {
  files: SourceTree;
  cwd: string;
  seen: Set<string>;
  checker?: ReturnType<typeof sourceClosureChecker>;
};

type StageClosureOptions = {
  root: string;
  stage: Stage;
  entries: readonly string[];
};
const stageClosureProblems = ({
  root,
  stage,
  entries,
}: StageClosureOptions) => {
  stage.checker ??= sourceClosureChecker(root, stage.files);
  return stage.checker(entries, stage.seen);
};

export const dockerPruneScopes = (source: string): string[][] =>
  dockerInstructions(source)
    .filter((line) => line.startsWith("RUN "))
    .flatMap((line) =>
      lexShell(line.slice(4)).flatMap((event) => {
        if (
          event.type !== "command" ||
          event.words[0] !== "turbo" ||
          event.words[1] !== "prune"
        ) {
          return [];
        }
        const scopes = event.words
          .slice(2)
          .filter((word) => !word.startsWith("--"));
        if (
          event.words.at(-1) !== "--docker" ||
          scopes.length === 0 ||
          scopes.some((scope) => !scope.startsWith("@stll/"))
        ) {
          panic("Unsupported Turbo prune command");
        }
        return [scopes];
      }),
    );

// Expand the package script actually named by a Docker RUN. Shell branching
// visits both sides conservatively; cd changes the path within that RUN only.
type SourceCommandEntry = {
  file: string;
  args: readonly string[];
  mode: "run" | "build" | "preload";
};

type CommandContext = {
  root: string;
  tree: SourceTree;
  active: Set<string>;
  consume?: (entry: SourceCommandEntry) => void;
  command?: (program: string | undefined, words: readonly string[]) => void;
};
type SourceCommandOptions = {
  command: string;
  words: string[];
  cwd: string;
  expand: (command: string, cwd: string) => SourceCommandEntry[];
};
type BunFlagPolicy =
  | "value"
  | "switch"
  | "optional-value"
  | "preload"
  | "cwd"
  | "workspace"
  | "unsupported";

// Bun 1.4.2 CLI help owns this census; tests reject new undocumented decisions.
const runtimeBunFlags = {
  "--silent": "switch",
  "--elide-lines": "value",
  "-F": "workspace",
  "--filter": "workspace",
  "-b": "switch",
  "--bun": "switch",
  "--no-orphans": "switch",
  "--shell": "value",
  "--workspaces": "unsupported",
  "--parallel": "switch",
  "--sequential": "switch",
  "--no-exit-on-error": "switch",
  "--watch": "switch",
  "--watch-kill-signal": "value",
  "--hot": "switch",
  "--no-clear-screen": "switch",
  "--smol": "switch",
  "--interactive": "switch",
  "-r": "preload",
  "--preload": "preload",
  "--require": "preload",
  "--import": "preload",
  "--inspect": "optional-value",
  "--inspect-wait": "optional-value",
  "--inspect-brk": "optional-value",
  "--cpu-prof": "switch",
  "--cpu-prof-name": "value",
  "--cpu-prof-dir": "value",
  "--cpu-prof-md": "switch",
  "--cpu-prof-interval": "value",
  "--heap-prof": "switch",
  "--heap-prof-name": "value",
  "--heap-prof-dir": "value",
  "--heap-prof-md": "switch",
  "--heap-prof-interval": "value",
  "--if-present": "switch",
  "--no-install": "switch",
  "--install": "value",
  "-i": "switch",
  "-e": "unsupported",
  "--eval": "unsupported",
  "-p": "unsupported",
  "--print": "unsupported",
  "--prefer-offline": "switch",
  "--prefer-latest": "switch",
  "--port": "value",
  "-C": "unsupported",
  "--conditions": "unsupported",
  "--fetch-preconnect": "value",
  "--experimental-http2-fetch": "switch",
  "--experimental-http3-fetch": "switch",
  "--max-http-header-size": "value",
  "--insecure-http-parser": "switch",
  "--dns-result-order": "value",
  "--experimental-stream-iter": "switch",
  "--expose-gc": "switch",
  "--no-deprecation": "switch",
  "--throw-deprecation": "switch",
  "--no-warnings": "switch",
  "--trace-warnings": "switch",
  "--trace-deprecation": "switch",
  "--pending-deprecation": "switch",
  "--redirect-warnings": "value",
  "--disable-warning": "value",
  "--title": "value",
  "--zero-fill-buffers": "switch",
  "--use-system-ca": "switch",
  "--use-openssl-ca": "switch",
  "--use-bundled-ca": "switch",
  "--tls-min-v1.0": "switch",
  "--tls-min-v1.1": "switch",
  "--tls-min-v1.2": "switch",
  "--tls-min-v1.3": "switch",
  "--tls-max-v1.2": "switch",
  "--tls-max-v1.3": "switch",
  "--redis-preconnect": "switch",
  "--sql-preconnect": "switch",
  "--no-addons": "switch",
  "--no-ffi-cc": "switch",
  "--unhandled-rejections": "value",
  "--console-depth": "value",
  "--user-agent": "value",
  "--cron-title": "value",
  "--cron-period": "value",
  "--main-fields": "value",
  "--preserve-symlinks": "switch",
  "--preserve-symlinks-main": "switch",
  "--extension-order": "value",
  "--tsconfig-override": "unsupported",
  "-d": "value",
  "--define": "value",
  "--drop": "value",
  "--feature": "value",
  "-l": "value",
  "--loader": "value",
  "--no-macros": "switch",
  "--jsx-factory": "value",
  "--jsx-fragment": "value",
  "--jsx-import-source": "value",
  "--jsx-runtime": "value",
  "--jsx-side-effects": "switch",
  "--ignore-dce-annotations": "switch",
  "--env-file": "value",
  "--no-env-file": "switch",
  "--cwd": "cwd",
  "-c": "unsupported",
  "--config": "unsupported",
  "-h": "unsupported",
  "--help": "unsupported",
} as const satisfies Record<string, BunFlagPolicy>;

export const BUN_FLAGS = {
  run: runtimeBunFlags,
  build: {
    ...runtimeBunFlags,
    "--production": "switch",
    "--compile": "switch",
    "--compile-exec-argv": "value",
    "--compile-autoload-dotenv": "switch",
    "--no-compile-autoload-dotenv": "switch",
    "--compile-autoload-bunfig": "switch",
    "--no-compile-autoload-bunfig": "switch",
    "--compile-autoload-tsconfig": "switch",
    "--no-compile-autoload-tsconfig": "switch",
    "--compile-autoload-package-json": "switch",
    "--no-compile-autoload-package-json": "switch",
    "--compile-executable-path": "unsupported",
    "--asset": "unsupported",
    "--bytecode": "switch",
    "--bytecode-depth": "value",
    "--watch": "switch",
    "--no-clear-screen": "switch",
    "--target": "value",
    "--outdir": "value",
    "--outfile": "value",
    "--metafile": "value",
    "--metafile-md": "value",
    "--sourcemap": "optional-value",
    "--banner": "value",
    "--footer": "value",
    "--format": "value",
    "--root": "value",
    "--splitting": "switch",
    "--no-split-require": "switch",
    "--no-module-preload": "switch",
    "--min-chunk-size": "value",
    "--public-path": "value",
    "-e": "value",
    "--external": "value",
    "--allow-unresolved": "value",
    "--reject-unresolved": "switch",
    "--packages": "value",
    "--entry-naming": "value",
    "--chunk-naming": "value",
    "--asset-naming": "value",
    "--react-fast-refresh": "switch",
    "--react-compiler": "switch",
    "--no-bundle": "switch",
    "--emit-dce-annotations": "switch",
    "--no-deprecated-namespace-object-setters": "switch",
    "--minify": "switch",
    "--minify-syntax": "switch",
    "--minify-whitespace": "switch",
    "--minify-identifiers": "switch",
    "--keep-names": "switch",
    "--css-chunking": "switch",
    "--conditions": "unsupported",
    "--app": "switch",
    "--server-components": "switch",
    "--env": "value",
    "--windows-hide-console": "switch",
    "--windows-icon": "value",
    "--windows-title": "value",
    "--windows-publisher": "value",
    "--windows-version": "value",
    "--windows-description": "value",
    "--windows-copyright": "value",
  },
} as const satisfies Record<"run" | "build", Record<string, BunFlagPolicy>>;

type BunFlagOptions = {
  words: readonly string[];
  index: number;
  flags: ReadonlyMap<string, BunFlagPolicy>;
};
const readBunFlag = ({ words, index, flags }: BunFlagOptions) => {
  const word = words[index] ?? "";
  const equals = word.indexOf("=");
  const name = equals === -1 ? word : word.slice(0, equals);
  const policy = flags.get(name);
  if (policy === undefined) {
    panic(`Unsupported Bun flag: ${word}`);
  }
  if (policy === "unsupported") {
    panic(`Unsupported Bun flag semantics: ${name}`);
  }
  if (policy === "switch" && equals !== -1) {
    panic(`Bun switch does not accept a value: ${word}`);
  }
  if (policy === "switch" || policy === "optional-value") {
    return { policy: "ignored", nextIndex: index } as const;
  }
  const nextIndex = equals === -1 ? index + 1 : index;
  const value = equals === -1 ? words[nextIndex] : word.slice(equals + 1);
  if (value === undefined || value.length === 0 || value.startsWith("-")) {
    panic(`Missing Bun flag value: ${name}`);
  }
  return { policy, value, nextIndex } as const;
};

type PackageScriptOptions = {
  name: string;
  cwd: string;
  expand: SourceCommandOptions["expand"];
};
const packageScriptEntries = (
  context: CommandContext,
  options: PackageScriptOptions,
) => {
  const owner = context.tree.get(`${options.cwd}/package.json`);
  const scripts =
    typeof owner === "string"
      ? (JSON.parse(text(context.root, owner)).scripts ?? {})
      : {};
  if (!Object.hasOwn(scripts, options.name)) {
    return undefined;
  }
  const key = `${options.cwd}#${options.name}`;
  if (context.active.has(key)) {
    panic(`Recursive build script: ${key}`);
  }
  context.active.add(key);
  const entries = options.expand(scripts[options.name], options.cwd);
  context.active.delete(key);
  return entries;
};

const workspaceCwd = (context: CommandContext, name: string) => {
  const owner = [...context.tree].find(
    ([file, origin]) =>
      file.endsWith("/package.json") &&
      typeof origin === "string" &&
      JSON.parse(text(context.root, origin)).name === name,
  );
  if (owner === undefined) {
    panic(`Filtered workspace is unavailable: ${name}`);
  }
  return path.posix.dirname(owner[0]);
};

const sourceCommandEntries = (
  context: CommandContext,
  options: SourceCommandOptions,
): SourceCommandEntry[] => {
  const { command } = options;
  const entries: SourceCommandEntry[] = [];
  let commandCwd = options.cwd;
  const words = options.words;
  let packageScript = words[0] === "run";
  if (words[0] === "run") {
    words.shift();
  }
  let mode: "build" | "run" =
    words[0] === "build" && !packageScript ? "build" : "run";
  if (mode === "build") {
    words.shift();
  }
  let flags = new Map(Object.entries(BUN_FLAGS[mode]));
  let found = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word.startsWith("-")) {
      const flag = readBunFlag({ words, index, flags });
      index = flag.nextIndex;
      if (flag.policy === "ignored") {
        continue;
      }
      const { policy, value } = flag;
      if (policy === "cwd") {
        if (entries.length > 0) {
          panic("Unsupported Bun cwd after a source entry");
        }
        commandCwd = absolute(commandCwd, value);
      } else if (policy === "workspace") {
        if (entries.length > 0) {
          panic("Unsupported Bun workspace after a source entry");
        }
        commandCwd = workspaceCwd(context, value);
        packageScript = true;
      } else if (policy === "preload") {
        if (!modulePattern.test(value)) {
          panic(`Unresolved Bun preload: ${value}`);
        }
        const preload = {
          file: absolute(commandCwd, value),
          args: [],
          mode: "preload",
        } satisfies SourceCommandEntry;
        entries.push(preload);
        context.consume?.(preload);
      }
      continue;
    }
    if (!found && word === "run") {
      packageScript = true;
      continue;
    }
    if (!found && word === "build" && !packageScript) {
      mode = "build";
      flags = new Map(Object.entries(BUN_FLAGS.build));
      continue;
    }
    if (!found && (word !== "build" || packageScript)) {
      const expanded = packageScriptEntries(context, {
        name: word,
        cwd: commandCwd,
        expand: options.expand,
      });
      if (expanded !== undefined) {
        entries.push(...expanded);
        return entries;
      }
    }
    if (!modulePattern.test(word)) {
      if (!found) {
        panic(`Unsupported Bun source command: ${command}`);
      }
      break;
    }
    const entry = {
      file: absolute(commandCwd, word),
      args: words.slice(index + 1),
      mode,
    } satisfies SourceCommandEntry;
    entries.push(entry);
    context.consume?.(entry);
    found = true;
    if (mode === "run") {
      break;
    }
  }
  if (!found) {
    panic(`No source entry in Bun command: ${command}`);
  }
  return entries;
};

type BunMetadataOptions = {
  words: readonly string[];
  tree: SourceTree;
  cwd: string;
};
const checkBunMetadata = ({ words, tree, cwd }: BunMetadataOptions) => {
  // The bootstrap prints a version from its copied manifest. Other inline
  // programs remain unresolved reads rather than bypassing the source model.
  if (
    words.length !== 2 ||
    !["-p", "--print"].includes(words[0] ?? "") ||
    !/^require\((?:"\.\/package\.json"|'\.\/package\.json')\)\.devDependencies\.turbo$/u.test(
      words[1] ?? "",
    )
  ) {
    return false;
  }
  if (!tree.has(absolute(cwd, "package.json"))) {
    panic("Bun metadata input is unavailable: package.json");
  }
  return true;
};

const isSourceFreeNpmCommand = (words: readonly string[]) =>
  words[0] === "install" ||
  (words.length === 3 &&
    words[0] === "cache" &&
    words[1] === "clean" &&
    words[2] === "--force");

const walkCommand = (
  context: CommandContext,
  command: string,
  initialCwd: string,
): SourceCommandEntry[] => {
  const { tree } = context;
  let cwd = initialCwd;
  const entries: SourceCommandEntry[] = [];
  const directories: string[] = [];
  for (const event of lexShell(command)) {
    if (event.type === "unparsed") {
      panic(event.reason);
    }
    if (event.type === "subshell-start") {
      directories.push(cwd);
      continue;
    }
    if (event.type === "subshell-end") {
      cwd = directories.pop() ?? initialCwd;
      continue;
    }
    if (event.type !== "command") {
      continue;
    }
    const words = [...event.words];
    while (
      /^\w+=/u.test(words[0] ?? "") ||
      (words[0] ?? "").startsWith("--mount=")
    ) {
      words.shift();
    }
    const program = words.shift();
    context.command?.(program, words);
    if (program === "cd") {
      cwd = absolute(cwd, words[0] ?? ".");
      continue;
    }
    if (program === "vite") {
      const directory = cwd;
      const config = ["vite.config.ts", "vite.config.js"]
        .map((file) => absolute(directory, file))
        .find((file) => tree.has(file));
      if (config === undefined) {
        panic(`Vite config is unavailable: ${cwd}`);
      }
      const viteEntries: SourceCommandEntry[] = [
        { file: config, args: [], mode: "build" },
        // Vite discovers route modules rather than importing them from config.
        ...[...tree.keys()]
          .filter(
            (file) =>
              file.startsWith(`${directory}/src/`) && modulePattern.test(file),
          )
          .map((file) => ({ file, args: [], mode: "build" as const })),
      ];
      entries.push(...viteEntries);
      for (const entry of viteEntries) {
        context.consume?.(entry);
      }
      continue;
    }
    if (["npm", "yarn", "pnpm", "npx", "bunx", "tsc"].includes(program ?? "")) {
      if (program === "npm" && isSourceFreeNpmCommand(words)) {
        continue;
      }
      panic(`Unsupported source runner: ${String(program)}`);
    }
    if (program !== "bun" && program !== "node") {
      continue;
    }
    if (program === "bun" && checkBunMetadata({ words, tree, cwd })) {
      continue;
    }
    if (["install", "i", "add"].includes(words[0] ?? "")) {
      continue;
    }
    entries.push(
      ...sourceCommandEntries(context, {
        command,
        words,
        cwd,
        expand: (source, directory) => walkCommand(context, source, directory),
      }),
    );
  }
  return entries;
};

export const commandEntries = (
  root: string,
  tree: SourceTree,
  command: string,
  cwd: string,
): string[] =>
  walkCommand({ root, tree, active: new Set() }, command, cwd).map(
    ({ file }) => file,
  );

const generatorEntries = (
  root: string,
  context: SourceTree,
  generator: Generator,
): readonly SourceCommandEntry[] => {
  const inventory: SourceTree = new Map(
    [...context].map(([file, origin]) => [`/app${file}`, origin]),
  );
  const words = [...generator.write];
  let cwd = "/app";
  const directory = words.find((word) => word.startsWith("--cwd="));
  if (directory !== undefined) {
    cwd = absolute(cwd, directory.slice("--cwd=".length));
    words.splice(words.indexOf(directory), 1);
    if (!inventory.has(`${cwd}/package.json`)) {
      return [];
    }
  }
  const filter = words.indexOf("--filter");
  if (
    filter !== -1 &&
    ![...inventory].some(
      ([file, origin]) =>
        file.endsWith("/package.json") &&
        JSON.parse(text(root, origin)).name === words.at(filter + 1),
    )
  ) {
    return [];
  }
  return walkCommand(
    { root, tree: inventory, active: new Set() },
    words.join(" "),
    cwd,
  );
};

type CopyInstructionOptions = {
  stages: Map<string, Stage>;
  stage: Stage;
  context: SourceTree;
  body: string;
  operation: "COPY" | "ADD";
};

const copyInstruction = ({
  stages,
  stage,
  context,
  body,
  operation,
}: CopyInstructionOptions) => {
  const words = body.split(/\s+/u);
  for (const word of words.filter((candidate) => candidate.startsWith("--"))) {
    if (
      !/^--(?:from|chown|chmod)=/u.test(word) ||
      (operation === "ADD" && word.startsWith("--from="))
    ) {
      panic(`Unsupported ${operation} flag: ${word}`);
    }
  }
  const from = words.find((word) => word.startsWith("--from="))?.slice(7);
  const paths = words.filter((word) => !word.startsWith("--"));
  const destination = paths.pop();
  if (destination === undefined) {
    panic(`Unsupported ${operation}: ${body}`);
  }
  const targetPath = absolute(stage.cwd, destination.replaceAll("\\$", "$"));
  const directoryTarget =
    destination.endsWith("/") ||
    stage.cwd === targetPath ||
    stage.cwd.startsWith(`${targetPath}/`) ||
    hasDirectory(stage.files, targetPath);
  if (paths.length > 1 && !directoryTarget) {
    panic(`Multiple ${operation} sources require a directory destination`);
  }
  const sourceTree = from === undefined ? context : stages.get(from)?.files;
  if (sourceTree === undefined) {
    panic(`Unknown COPY stage: ${String(from)}`);
  }
  // Runtime generated/native assets belong to the packaged-asset guard.
  if (from !== undefined && !["pruner", "install-inputs"].includes(from)) {
    return;
  }
  if (body.startsWith("[") || /(?<!\\)\$/u.test(body)) {
    panic(`Unsupported ${operation}: ${body}`);
  }
  stage.seen.clear();
  delete stage.checker;
  for (const file of paths) {
    const sourcePath = absolute(from === undefined ? "/" : "/app", file);
    const target = targetPath + (directoryTarget ? "/" : "");
    copySource(sourceTree, stage.files, sourcePath, target);
  }
};

export const checkDockerSource = (
  root: string,
  source: string,
  context: SourceTree,
  pruned: SourceTree,
): string[] => {
  const producers = GENERATORS.filter(
    ({ outputKind }) => outputKind === "derived",
  ).map((generator) => ({
    generator,
    entries: generatorEntries(root, context, generator),
  }));
  const stages = new Map<string, Stage>();
  let stage: Stage = { cwd: "/", files: new Map(), seen: new Set() };
  const problems: string[] = [];
  let index = 0;
  for (const instruction of dockerInstructions(source)) {
    const split = instruction.indexOf(" ");
    const operation = instruction.slice(0, split);
    const body = instruction.slice(split + 1);
    if (operation === "FROM") {
      const words = body.split(/\s+/u).filter((word) => !word.startsWith("--"));
      const parent = stages.get(words[0] ?? "");
      stage = {
        cwd: parent?.cwd ?? "/",
        files: new Map(parent?.files),
        seen: new Set(),
      };
      stages.set(words[2] ?? `stage-${index++}`, stage);
    } else if (operation === "WORKDIR") {
      stage.cwd = absolute(stage.cwd, body);
    } else if (operation === "ADD") {
      const words = body.split(/\s+/u);
      const inputs = words.filter((word) => !word.startsWith("--"));
      const archive = /\.(?:tar(?:\.(?:gz|xz|bz2))?|tgz|zip)$/iu;
      const [url, target] = inputs;
      if (url !== undefined && !/^https?:\/\//u.test(url)) {
        if (inputs.some((input) => archive.test(input))) {
          panic(`Unsupported source instruction: ${instruction}`);
        }
        copyInstruction({ stages, stage, context, body, operation: "ADD" });
        continue;
      }
      const targetPath =
        target === undefined ? "" : absolute(stage.cwd, target);
      const directoryTarget =
        target?.endsWith("/") ||
        stage.cwd === targetPath ||
        stage.cwd.startsWith(`${targetPath}/`) ||
        hasDirectory(stage.files, targetPath);
      if (
        words.some(
          (word) =>
            word.startsWith("--") &&
            !/^--checksum=sha256:[a-f0-9]{64}$/u.test(word),
        ) ||
        inputs.length !== 2 ||
        url === undefined ||
        target === undefined ||
        !/^https?:\/\//u.test(url) ||
        !archive.test(url) ||
        (!archive.test(target) && !directoryTarget) ||
        /[$\\]/u.test(body)
      ) {
        panic(`Unsupported source instruction: ${instruction}`);
      }
      // Remote archives stay opaque: neither ADD nor a later native unpack
      // declares repository modules available to a Bun source runner.
    } else if (operation === "COPY") {
      copyInstruction({ stages, stage, context, body, operation: "COPY" });
    } else if (operation === "RUN") {
      const runStage = stage;
      walkCommand(
        {
          root,
          tree: runStage.files,
          active: new Set(),
          command: (program, words) => {
            if (program === "turbo" && words.at(0) === "prune") {
              runStage.seen.clear();
              delete runStage.checker;
              for (const [file, origin] of pruned) {
                runStage.files.set(`/app/out/full${file.slice(4)}`, origin);
                if (file.endsWith("/package.json")) {
                  runStage.files.set(`/app/out/json${file.slice(4)}`, origin);
                }
              }
            } else if (
              program === "find" &&
              words.at(0) === "apps" &&
              words.at(1) === "packages" &&
              words.some((word) => word.includes("/json/"))
            ) {
              runStage.seen.clear();
              delete runStage.checker;
              for (const [file, origin] of [...runStage.files]) {
                if (
                  file === "/app/package.json" ||
                  file === "/app/bun.lock" ||
                  file.endsWith("/package.json") ||
                  /^\/app\/(?:bunfig\.toml|\.npmrc|patches\/)/u.test(file)
                ) {
                  runStage.files.set(`/json/${file.slice(5)}`, origin);
                }
              }
            }
          },
          consume: (entry) => {
            if (entry.file.includes("/dist/")) {
              return;
            }
            const closure = stageClosureProblems({
              root,
              stage: runStage,
              entries: [entry.file],
            });
            problems.push(...closure);
            if (closure.length > 0) {
              return;
            }
            // A Docker RUN can create declared sources after validating its own
            // source closure. Only hydrated outputs of that exact producer enter
            // the stage; later imports still resolve against this inventory.
            for (const { generator, entries: producerEntries } of producers) {
              if (
                entry.mode !== "run" ||
                !producerEntries.some(
                  (producer) =>
                    producer.file === entry.file &&
                    JSON.stringify(producer.args) ===
                      JSON.stringify(entry.args),
                )
              ) {
                continue;
              }
              for (const output of generator.outputs) {
                if (!existsSync(path.join(root, output))) {
                  problems.push(
                    `Generated output is unavailable: ${generator.id}/${output}`,
                  );
                  continue;
                }
                runStage.files.set(absolute("/app", output), output);
              }
              runStage.seen.clear();
              delete runStage.checker;
            }
          },
        },
        body,
        runStage.cwd,
      );
    }
  }
  return [...new Set(problems)];
};

export const checkRepositoryDockerSources = (root: string): string[] => {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
  if (tracked.exitCode !== 0) {
    panic("Cannot enumerate Docker sources");
  }
  const files = tracked.stdout.toString().split("\0").filter(Boolean);
  const ignore = text(root, ".dockerignore");
  const context: SourceTree = new Map(
    files
      .filter((file) => inDockerContext(file, ignore))
      .map((file) => [`/${file}`, file]),
  );
  const dockerfiles = files.filter((file) =>
    /(?:^|\/)(?:Dockerfile|[^/]+\.Dockerfile)$/u.test(file),
  );
  const problems: string[] = [];
  const scratchParent = path.join(root, ".cache");
  mkdirSync(scratchParent, { recursive: true });
  const scratch = mkdtempSync(
    path.join(scratchParent, "docker-source-closure-"),
  );
  try {
    for (const file of dockerfiles) {
      const source = text(root, file);
      const scopes = dockerPruneScopes(source);
      if (scopes.length > 1) {
        panic(`Multiple prune graphs are unsupported: ${file}`);
      }
      const pruned: SourceTree = new Map();
      if (scopes.length === 1) {
        const directory = path.join(
          scratch,
          String(problems.length),
          file.replaceAll("/", "-"),
        );
        const prune = Bun.spawnSync(
          [
            path.join(root, "node_modules/.bin/turbo"),
            "prune",
            ...(scopes[0] ?? []),
            "--docker",
            `--out-dir=${directory}`,
          ],
          { cwd: root, env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" } },
        );
        if (prune.exitCode !== 0) {
          panic(`Turbo prune failed for ${file}: ${prune.stderr.toString()}`);
        }
        for (const entry of filesBelow(path.join(directory, "full"))) {
          if (inDockerContext(entry, ignore)) {
            pruned.set(`/app/${entry}`, entry);
          }
        }
      }
      problems.push(
        ...checkDockerSource(root, source, context, pruned).map(
          (problem) => `${file}: ${problem}`,
        ),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
};

if (import.meta.main) {
  const start = performance.now();
  const problems = checkRepositoryDockerSources(
    path.resolve(import.meta.dir, ".."),
  );
  if (problems.length > 0) {
    panic(problems.join("\n"));
  }
  console.log(
    `Docker source closure checked in ${((performance.now() - start) / 1000).toFixed(2)}s`,
  );
}
