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
type Stage = { files: SourceTree; cwd: string; seen: Set<string> };
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

export const copySource = (
  source: SourceTree,
  destination: SourceTree,
  from: string,
  to: string,
) => {
  const exact = source.get(from);
  if (exact !== undefined) {
    destination.set(
      to.endsWith("/") ? `${to}${path.posix.basename(from)}` : to,
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
      panic(`Inherited tsconfig is unavailable: ${key}`);
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
export const sourceClosureProblems = (
  root: string,
  tree: SourceTree,
  entries: readonly string[],
  seen = new Set<string>(),
): string[] => {
  const problems: string[] = [];
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
      // Installed registry packages and builtins are outside the source twin.
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      const local =
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.startsWith("@/") ||
        workspaces.has(name ?? "");
      if (!local) {
        continue;
      }
      const clean = specifier.replace(
        /\?(?:raw|url|worker|sharedworker)(?:&(?:raw|url|worker|sharedworker))*$/u,
        "",
      );
      if (clean.startsWith(".")) {
        const resolved = specifierCandidates(file, clean).find(sourceAvailable);
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
      const alias = Object.entries(options.paths ?? {})
        .flatMap(([pattern, targets]) => {
          const [prefix, suffix] = pattern.split("*");
          const wildcard = pattern.includes("*");
          if (
            wildcard
              ? !clean.startsWith(prefix ?? "") || !clean.endsWith(suffix ?? "")
              : clean !== pattern
          ) {
            return [];
          }
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
        })
        .find(sourceAvailable);
      const resolved =
        alias ??
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
type CommandContext = { root: string; tree: SourceTree; active: Set<string> };
type SourceCommandOptions = {
  command: string;
  words: string[];
  cwd: string;
  expand: (command: string, cwd: string) => string[];
};
const sourceCommandEntries = (
  context: CommandContext,
  options: SourceCommandOptions,
): string[] => {
  const { root, tree, active } = context;
  const { command } = options;
  const entries: string[] = [];
  let commandCwd = options.cwd;
  let words = options.words;
  const packageScript = words[0] === "--filter" || words[0] === "run";
  if (words[0] === "--filter") {
    const name = words[1];
    const owner = [...tree].find(
      ([file, origin]) =>
        file.endsWith("/package.json") &&
        typeof origin === "string" &&
        JSON.parse(text(root, origin)).name === name,
    );
    if (owner === undefined) {
      panic(`Filtered workspace is unavailable: ${String(name)}`);
    }
    commandCwd = path.posix.dirname(owner[0]);
    words = words.slice(2);
  }
  if (words[0] === "run") {
    words.shift();
  }
  const manifest = tree.get(`${commandCwd}/package.json`);
  const scripts =
    typeof manifest === "string"
      ? (JSON.parse(text(root, manifest)).scripts ?? {})
      : {};
  const script = words[0];
  if (
    script !== undefined &&
    script in scripts &&
    (script !== "build" || packageScript)
  ) {
    const key = `${commandCwd}#${script}`;
    if (active.has(key)) {
      panic(`Recursive build script: ${key}`);
    }
    active.add(key);
    entries.push(...options.expand(scripts[script], commandCwd));
    active.delete(key);
    return entries;
  }
  if (words[0] === "build") {
    words.shift();
  }
  const flagValues = new Set([
    "--define",
    "--target",
    "--outfile",
    "--outdir",
    "--entry-naming",
    "--sourcemap",
    "--external",
  ]);
  const booleanFlags = new Set([
    "--compile",
    "--no-compile-autoload-dotenv",
    "--minify",
    "--splitting",
  ]);
  let found = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (flagValues.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("--")) {
      const name = word.split("=")[0] ?? "";
      if (!flagValues.has(name) && !booleanFlags.has(name)) {
        panic(`Unsupported Bun flag: ${word}`);
      }
      continue;
    }
    if (!modulePattern.test(word)) {
      if (!found) {
        panic(`Unsupported Bun source command: ${command}`);
      }
      break;
    }
    entries.push(absolute(commandCwd, word));
    found = true;
  }
  if (!found) {
    panic(`No source entry in Bun command: ${command}`);
  }
  return entries;
};

const walkCommand = (
  context: CommandContext,
  command: string,
  initialCwd: string,
): string[] => {
  const { tree } = context;
  let cwd = initialCwd;
  const entries: string[] = [];
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
      entries.push(config);
      // Vite discovers route modules rather than importing them from config.
      entries.push(
        ...[...tree.keys()].filter(
          (file) =>
            file.startsWith(`${directory}/src/`) && modulePattern.test(file),
        ),
      );
      continue;
    }
    if (["npm", "yarn", "pnpm", "npx", "bunx", "tsc"].includes(program ?? "")) {
      if (
        program === "npm" &&
        (words[0] === "install" ||
          (words.length === 3 &&
            words[0] === "cache" &&
            words[1] === "clean" &&
            words[2] === "--force"))
      ) {
        continue;
      }
      panic(`Unsupported source runner: ${String(program)}`);
    }
    if (program !== "bun" && program !== "node") {
      continue;
    }
    if (["install", "i", "add", "-p", "-e"].includes(words[0] ?? "")) {
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
): string[] => walkCommand({ root, tree, active: new Set() }, command, cwd);

const generatorEntries = (
  root: string,
  context: SourceTree,
  generator: Generator,
): readonly string[] => {
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
  return commandEntries(root, inventory, words.join(" "), cwd);
};

const copyInstruction = (
  stages: Map<string, Stage>,
  stage: Stage,
  context: SourceTree,
  body: string,
) => {
  const words = body.split(/\s+/u);
  for (const word of words.filter((candidate) => candidate.startsWith("--"))) {
    if (!/^--(?:from|chown|chmod)=/u.test(word)) {
      panic(`Unsupported COPY flag: ${word}`);
    }
  }
  const from = words.find((word) => word.startsWith("--from="))?.slice(7);
  const paths = words.filter((word) => !word.startsWith("--"));
  const destination = paths.pop();
  if (destination === undefined) {
    panic(`Unsupported COPY: ${body}`);
  }
  if (paths.length > 1 && !destination.endsWith("/")) {
    panic("Multiple COPY sources require a directory destination");
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
    panic(`Unsupported COPY: ${body}`);
  }
  stage.seen.clear();
  for (const file of paths) {
    const sourcePath = absolute(from === undefined ? "/" : "/app", file);
    const target =
      absolute(stage.cwd, destination.replaceAll("\\$", "$")) +
      (destination.endsWith("/") || destination === "." ? "/" : "");
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
      panic(`Unsupported source instruction: ${instruction}`);
    } else if (operation === "COPY") {
      copyInstruction(stages, stage, context, body);
    } else if (operation === "RUN") {
      if (/\bturbo prune\b/u.test(body)) {
        for (const [file, origin] of pruned) {
          stage.files.set(`/app/out/full${file.slice(4)}`, origin);
          if (file.endsWith("/package.json")) {
            stage.files.set(`/app/out/json${file.slice(4)}`, origin);
          }
        }
        continue;
      }
      if (body.includes("find apps packages") && body.includes("/json/")) {
        for (const [file, origin] of [...stage.files]) {
          if (
            file === "/app/package.json" ||
            file === "/app/bun.lock" ||
            file.endsWith("/package.json") ||
            /^\/app\/(?:bunfig\.toml|\.npmrc|patches\/)/u.test(file)
          ) {
            stage.files.set(`/json/${file.slice(5)}`, origin);
          }
        }
        continue;
      }
      if (!/\b(?:bun|node|vite|npm|yarn|pnpm|npx|bunx|tsc)\b/u.test(body)) {
        continue;
      }
      const entries = commandEntries(root, stage.files, body, stage.cwd);
      for (const entry of entries.filter((file) => !file.includes("/dist/"))) {
        const closure = sourceClosureProblems(
          root,
          stage.files,
          [entry],
          stage.seen,
        );
        problems.push(...closure);
        if (closure.length > 0) {
          continue;
        }
        // A Docker RUN can create declared sources after validating its own
        // source closure. Only hydrated outputs of that exact producer enter
        // the stage; later imports still resolve against this inventory.
        for (const { generator, entries: producerEntries } of producers) {
          if (!producerEntries.includes(entry)) {
            continue;
          }
          for (const output of generator.outputs) {
            if (!existsSync(path.join(root, output))) {
              problems.push(
                `Generated output is unavailable: ${generator.id}/${output}`,
              );
              continue;
            }
            stage.files.set(absolute("/app", output), output);
          }
          stage.seen.clear();
        }
      }
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
