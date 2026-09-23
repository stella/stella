#!/usr/bin/env bun

// Instruction-reference guard.
//
// Agent instruction files (AGENTS.md, scoped guides, and local skill mirrors) name
// concrete repository paths, package scripts, module exports, and lint rule ids.
// Nothing compiles them, so a rename in the code leaves the instruction quietly
// wrong and every agent that reads it is misled. This guard resolves each named
// reference against the tree and fails when one no longer exists.
//
// Checked reference kinds:
//   path     a backtick-quoted repository path (apps/, packages/, scripts/,
//            docs/, .claude/, .agents/, .github/, .oxlint-plugins/, deploy/)
//            must exist as a file or directory. Glob forms are skipped.
//   command  `bun run <name>` and `bun --filter <pkg> <name>` must name a script
//            in the root or that workspace's package.json; `bun <path>.ts` must
//            name a file that exists.
//   export   `` `<Name>` from `<specifier>` `` for a @/api/, @/ (web) or @stll/
//            specifier must resolve to a module that exports <Name>.
//   rule     a `<plugin>/<rule>` token whose plugin names a module in
//            .oxlint-plugins/ must be a rule that oxlint.config.ts registers.
//            Third-party ids and bare kebab tokens are too ambiguous to check.
//
// Intentional non-existent examples live in
// scripts/instruction-references-allowlist.json; an entry that suppresses
// nothing fails as stale, so the list can only shrink.
//
// Usage:
//   bun scripts/check-instruction-references.ts --check
//   bun scripts/check-instruction-references.ts --self-test

import { panic } from "better-result";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const ALLOWLIST_PATH = "scripts/instruction-references-allowlist.json";
const ROOT_PACKAGE = "package.json";
const OXLINT_CONFIG = "oxlint.config.ts";
const WORKSPACE_PARENTS = ["apps", "packages"] as const;

// A backtick token starting with one of these is a repository path claim.
const REPO_PATH_PREFIXES = [
  "apps/",
  "packages/",
  "scripts/",
  "docs/",
  ".claude/",
  ".agents/",
  ".github/",
  ".oxlint-plugins/",
  "deploy/",
] as const;

const GLOB_CHARACTERS = ["*", "{", "<"] as const;

// Module specifier aliases, resolved from tsconfig `paths`: apps/api maps
// "@/api/*" to its src, apps/web maps "@/api/*" to ../api/src for Eden and the
// bare "@/*" to its own src. The api prefix is listed first so it wins.
const SPECIFIER_ALIASES = [
  { prefix: "@/api/", root: "apps/api/src/" },
  { prefix: "@/", root: "apps/web/src/" },
] as const;

const MODULE_EXTENSIONS = [".ts", ".tsx"] as const;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// What a `bun …` invocation names, which decides where the name is looked up.
type CommandScope =
  | { readonly kind: "file" }
  | { readonly kind: "root" }
  | { readonly kind: "workspace"; readonly name: string };

// `line` and `reference` (the literal token, which the output and the allowlist
// both key on) are common; the rest is what that kind needs to resolve.
type Located = {
  readonly line: number;
  readonly reference: string;
};

type Reference =
  | (Located & { readonly kind: "path" })
  | (Located & { readonly kind: "rule" })
  | (Located & { readonly kind: "command"; readonly scope: CommandScope })
  | (Located & { readonly kind: "export"; readonly specifier: string });

type ReferenceKind = Reference["kind"];

export type Problem = Reference & {
  readonly file: string;
  readonly why: string;
};

export type AllowlistEntry = {
  readonly file: string;
  readonly reference: string;
  readonly reason: string;
};

// Every filesystem read goes through this seam so the tests can drive the whole
// matcher from in-memory fixtures.
export type Repo = {
  readonly exists: (repoPath: string) => boolean;
  readonly read: (repoPath: string) => string | undefined;
};

// --- Extraction -------------------------------------------------------------

const lineAt = (text: string, offset: number): number =>
  text.slice(0, offset).split("\n").length;

const BACKTICK_SPAN = /`([^`\n]+)`/gu;
// Hard-wrapped prose puts the specifier on the next line, so the export form
// matches across a newline.
const EXPORT_FORM = /`([A-Za-z_$][A-Za-z0-9_$]*)`\s+from\s+`([^`\n]+)`/gu;

const TOKEN_PREFIX_CHARACTERS = new Set(["(", '"', "'"]);
const TOKEN_SUFFIX_CHARACTERS = new Set([")", ".", ",", ";", ":", '"', "'"]);

const trimToken = (token: string): string => {
  let start = 0;
  while (TOKEN_PREFIX_CHARACTERS.has(token[start] ?? "")) {
    start += 1;
  }
  let end = token.length;
  while (TOKEN_SUFFIX_CHARACTERS.has(token[end - 1] ?? "")) {
    end -= 1;
  }
  return token.slice(start, end);
};

const hasGlob = (token: string): boolean =>
  GLOB_CHARACTERS.some((character) => token.includes(character));

const isRepoPathToken = (token: string): boolean =>
  REPO_PATH_PREFIXES.some((prefix) => token.startsWith(prefix));

// `origin/main`, `tools/list` and third-party ids are shaped like rule ids too.
// A Stella rule always lives in a plugin module, so that module is what makes a
// token recognizable as a rule id at all.
const isRuleIdToken = (repo: Repo, token: string): boolean => {
  const segments = token.split("/");
  const [plugin, rule] = segments;
  if (segments.length !== 2 || plugin === undefined || rule === undefined) {
    return false;
  }
  return (
    KEBAB.test(plugin) &&
    KEBAB.test(rule) &&
    repo.exists(`.oxlint-plugins/${plugin}.ts`)
  );
};

type CommandReference = {
  readonly reference: string;
  readonly scope: CommandScope;
};

// Parse one `bun ...` invocation. Returns the script or file it names; a form
// this guard does not model yields nothing rather than a guess.
const bunCommandReferences = (tokens: string[]): CommandReference[] => {
  const found: CommandReference[] = [];
  let workspace: string | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token === undefined ||
      token === "&&" ||
      token === "|" ||
      token === ";"
    ) {
      break;
    }
    if (token === "--filter" || token === "--cwd") {
      workspace = tokens[index + 1];
      index += 1;
      continue;
    }
    if (token === "run") {
      const name = tokens[index + 1];
      if (name !== undefined && !name.startsWith("-")) {
        found.push({
          reference: name,
          scope:
            workspace === undefined
              ? { kind: "root" }
              : { kind: "workspace", name: workspace },
        });
      }
      return found;
    }
    if (token.endsWith(".ts") || token.endsWith(".tsx")) {
      found.push({ reference: token, scope: { kind: "file" } });
      return found;
    }
    if (token.startsWith("-") || token === "test" || token === "--bun") {
      continue;
    }
    // A bare word after `bun --filter <pkg>` is that workspace's script.
    if (workspace !== undefined && /^[a-z][\w:-]*$/u.test(token)) {
      found.push({
        reference: token,
        scope: { kind: "workspace", name: workspace },
      });
      return found;
    }
  }

  return found;
};

const extractReferences = (repo: Repo, text: string): Reference[] => {
  const references: Reference[] = [];
  const seen = new Set<string>();

  const add = (reference: Reference): void => {
    const key = [reference.kind, reference.reference, reference.line].join(" ");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    references.push(reference);
  };

  for (const match of text.matchAll(BACKTICK_SPAN)) {
    const span = match.at(1);
    if (span === undefined) {
      continue;
    }
    const line = lineAt(text, match.index);
    const tokens = span.split(/\s+/u).filter(Boolean);

    for (const raw of tokens) {
      const token = trimToken(raw);
      if (token === "" || hasGlob(token)) {
        continue;
      }
      // A leading slash is how prose writes an absolute repository path.
      const repoPath = token.startsWith("/") ? token.slice(1) : token;
      if (isRepoPathToken(repoPath)) {
        add({ kind: "path", line, reference: repoPath });
        continue;
      }
      if (isRuleIdToken(repo, token)) {
        add({ kind: "rule", line, reference: token });
      }
    }

    if (tokens[0] === "bun") {
      for (const command of bunCommandReferences(tokens)) {
        if (hasGlob(command.reference)) {
          continue;
        }
        add({
          kind: "command",
          line,
          reference: command.reference,
          scope: command.scope,
        });
      }
    }
  }

  for (const match of text.matchAll(EXPORT_FORM)) {
    const name = match.at(1);
    const specifier = match.at(2);
    if (name === undefined || specifier === undefined) {
      continue;
    }
    if (!isCheckedSpecifier(specifier)) {
      continue;
    }
    add({
      kind: "export",
      line: lineAt(text, match.index),
      reference: name,
      specifier,
    });
  }

  return references;
};

const isCheckedSpecifier = (specifier: string): boolean =>
  specifier.startsWith("@stll/") ||
  SPECIFIER_ALIASES.some((alias) => specifier.startsWith(alias.prefix));

// --- Resolution -------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readJson = (
  repo: Repo,
  repoPath: string,
): Record<string, unknown> | undefined => {
  const raw = repo.read(repoPath);
  if (raw === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  return isRecord(parsed) ? parsed : undefined;
};

const packageScripts = (
  repo: Repo,
  packagePath: string,
): Record<string, unknown> | undefined => {
  const scripts = readJson(repo, packagePath)?.["scripts"];
  return isRecord(scripts) ? scripts : undefined;
};

const workspaceDirectory = (
  repo: Repo,
  packageName: string,
): string | undefined => {
  const shortName = packageName.replace(/^@stll\//u, "");
  for (const parent of WORKSPACE_PARENTS) {
    const candidate = `${parent}/${shortName}/package.json`;
    if (readJson(repo, candidate)?.["name"] === packageName) {
      return `${parent}/${shortName}`;
    }
  }
  return undefined;
};

const moduleCandidates = (base: string): string[] => [
  base,
  ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`),
  ...MODULE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
];

const EXPORT_CONDITIONS = ["types", "bun", "import", "module", "default"];

const exportTargetPath = (target: unknown): string | undefined => {
  if (typeof target === "string") {
    return target;
  }
  if (Array.isArray(target)) {
    return target.map(exportTargetPath).find((value) => value !== undefined);
  }
  if (!isRecord(target)) {
    return undefined;
  }
  for (const condition of EXPORT_CONDITIONS) {
    const resolved = exportTargetPath(target[condition]);
    if (resolved !== undefined) {
      return resolved;
    }
  }
  return Object.values(target)
    .map(exportTargetPath)
    .find((value) => value !== undefined);
};

const subpathExportTarget = (
  exports: Record<string, unknown>,
  subpath: string,
): string | undefined => {
  const exact = exportTargetPath(exports[subpath]);
  if (exact !== undefined) {
    return exact;
  }
  for (const [pattern, target] of Object.entries(exports)) {
    const wildcard = pattern.indexOf("*");
    if (wildcard === -1) {
      continue;
    }
    const prefix = pattern.slice(0, wildcard);
    const suffix = pattern.slice(wildcard + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) {
      continue;
    }
    const matched = subpath.slice(
      prefix.length,
      subpath.length - suffix.length,
    );
    return exportTargetPath(target)?.replaceAll("*", () => matched);
  }
  return undefined;
};

const packageEntry = (repo: Repo, specifier: string): string | undefined => {
  const withoutScope = specifier.slice("@stll/".length);
  const slash = withoutScope.indexOf("/");
  const packageName =
    slash === -1 ? withoutScope : withoutScope.slice(0, slash);
  const subpath = slash === -1 ? "." : `.${withoutScope.slice(slash)}`;
  const directory = workspaceDirectory(repo, `@stll/${packageName}`);
  if (directory === undefined) {
    return undefined;
  }

  const exports = readJson(repo, `${directory}/package.json`)?.["exports"];
  if (exports !== undefined) {
    const isSubpathMap =
      isRecord(exports) &&
      Object.keys(exports).some((key) => key.startsWith("."));
    let targetPath: string | undefined;
    if (isSubpathMap) {
      targetPath = subpathExportTarget(exports, subpath);
    } else if (subpath === ".") {
      targetPath = exportTargetPath(exports);
    }
    return typeof targetPath === "string"
      ? path.posix.join(directory, targetPath)
      : undefined;
  }
  if (subpath === ".") {
    return `${directory}/src/index.ts`;
  }
  return `${directory}/src/${subpath.slice(2)}`;
};

const resolveSpecifier = (
  repo: Repo,
  specifier: string,
): string | undefined => {
  for (const { prefix, root } of SPECIFIER_ALIASES) {
    if (specifier.startsWith(prefix)) {
      const base = `${root}${specifier.slice(prefix.length)}`;
      return moduleCandidates(base).find(
        (candidate) => repo.read(candidate) !== undefined,
      );
    }
  }
  const entry = packageEntry(repo, specifier);
  if (entry === undefined) {
    return undefined;
  }
  return moduleCandidates(entry).find(
    (candidate) => repo.read(candidate) !== undefined,
  );
};

const EXPORT_DECLARATION =
  /export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/gu;

const declaresExport = (source: string, name: string): boolean => {
  if (
    [...source.matchAll(EXPORT_DECLARATION)].some((match) => match[1] === name)
  ) {
    return true;
  }
  // `export { a, b as c }` and `export type { … }`, including re-export forms.
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/gu)) {
    const clause = match[1];
    if (clause === undefined) {
      continue;
    }
    const exported = clause.split(",").map((item) => {
      const parts = item.trim().split(/\s/u).filter(Boolean);
      const aliasIndex = parts.lastIndexOf("as");
      return aliasIndex === -1
        ? (parts.at(0) ?? "")
        : (parts.at(aliasIndex + 1) ?? "");
    });
    if (exported.includes(name)) {
      return true;
    }
  }
  return false;
};

const starReexports = (source: string): string[] =>
  [...source.matchAll(/export\s+\*\s+from\s+["']([^"']+)["']/gu)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);

const resolveRelative = (
  repo: Repo,
  from: string,
  specifier: string,
): string | undefined => {
  const base = specifier.startsWith(".")
    ? path.posix.join(path.posix.dirname(from), specifier)
    : undefined;
  if (base === undefined) {
    return resolveSpecifier(repo, specifier);
  }
  return moduleCandidates(base.replace(/\.js$/u, "")).find(
    (candidate) => repo.read(candidate) !== undefined,
  );
};

// One level of `export * from` is followed: a barrel re-exporting a barrel is
// already outside the conventions this repository writes.
const exportsName = (repo: Repo, modulePath: string, name: string): boolean => {
  const source = repo.read(modulePath);
  if (source === undefined) {
    return false;
  }
  if (declaresExport(source, name)) {
    return true;
  }
  for (const specifier of starReexports(source)) {
    const nested = resolveRelative(repo, modulePath, specifier);
    if (nested === undefined) {
      continue;
    }
    const nestedSource = repo.read(nested);
    if (nestedSource !== undefined && declaresExport(nestedSource, name)) {
      return true;
    }
  }
  return false;
};

const knowsRule = (repo: Repo, ruleId: string): boolean => {
  const config = repo.read(OXLINT_CONFIG);
  if (config === undefined) {
    return false;
  }
  const configuredRule = /["']([^"']+)["']\s*:/gu;
  return [...config.matchAll(configuredRule)].some(
    (match) => match.at(1) === ruleId,
  );
};

// --- Checking ---------------------------------------------------------------

const scriptProblem = (
  repo: Repo,
  packagePath: string,
  name: string,
): string | undefined =>
  packageScripts(repo, packagePath)?.[name] === undefined
    ? `no such script in ${packagePath}`
    : undefined;

const commandProblem = (
  repo: Repo,
  name: string,
  scope: CommandScope,
): string | undefined => {
  switch (scope.kind) {
    case "file":
      return repo.exists(name) ? undefined : "file does not exist";
    case "root":
      return scriptProblem(repo, ROOT_PACKAGE, name);
    case "workspace": {
      const directory = workspaceDirectory(repo, scope.name);
      return directory === undefined
        ? `no workspace named ${scope.name}`
        : scriptProblem(repo, `${directory}/package.json`, name);
    }
    default:
      scope satisfies never;
      return panic("Unhandled command scope");
  }
};

const referenceProblem = (
  repo: Repo,
  reference: Reference,
): string | undefined => {
  switch (reference.kind) {
    case "path":
      return repo.exists(reference.reference)
        ? undefined
        : "no such file or directory";
    case "command":
      return commandProblem(repo, reference.reference, reference.scope);
    case "export": {
      const { specifier } = reference;
      const modulePath = resolveSpecifier(repo, specifier);
      if (modulePath === undefined) {
        return `${specifier} does not resolve to a module`;
      }
      return exportsName(repo, modulePath, reference.reference)
        ? undefined
        : `${modulePath} exports no ${reference.reference}`;
    }
    case "rule":
      return knowsRule(repo, reference.reference)
        ? undefined
        : "no such oxlint plugin rule";
    default:
      reference satisfies never;
      return panic("Unhandled reference kind");
  }
};

export const checkFile = (
  repo: Repo,
  file: string,
  text: string,
): Problem[] => {
  const problems: Problem[] = [];
  for (const reference of extractReferences(repo, text)) {
    const why = referenceProblem(repo, reference);
    if (why !== undefined) {
      problems.push({ ...reference, file, why });
    }
  }
  return problems;
};

export const formatProblem = ({
  file,
  line,
  kind,
  reference,
  why,
}: Problem): string => `${file}:${line}: ${kind} ${reference} (${why})`;

export type AllowlistResult = {
  readonly problems: Problem[];
  readonly staleEntries: AllowlistEntry[];
};

// An entry earns its place by suppressing a live problem. One that suppresses
// nothing is stale and fails, so the allowlist can only shrink.
export const applyAllowlist = (
  problems: readonly Problem[],
  allowlist: readonly AllowlistEntry[],
): AllowlistResult => {
  const used = new Set<number>();
  const remaining = problems.filter((problem) => {
    const index = allowlist.findIndex(
      (entry) =>
        entry.file === problem.file && entry.reference === problem.reference,
    );
    if (index === -1) {
      return true;
    }
    used.add(index);
    return false;
  });
  return {
    problems: remaining,
    staleEntries: allowlist.filter((_, index) => !used.has(index)),
  };
};

// --- Repository access ------------------------------------------------------

const diskRepo = (): Repo => {
  const cache = new Map<string, string | undefined>();
  return {
    exists: (repoPath) => existsSync(path.join(REPO_ROOT, repoPath)),
    read: (repoPath) => {
      if (!cache.has(repoPath)) {
        const absolute = path.join(REPO_ROOT, repoPath);
        cache.set(
          repoPath,
          existsSync(absolute) && statSync(absolute).isFile()
            ? readFileSync(absolute, "utf-8")
            : undefined,
        );
      }
      return cache.get(repoPath);
    },
  };
};

// Every agent instruction file: root and workspace AGENTS.md files, nested
// guides, and skills.
const INSTRUCTION_GLOBS = [
  "AGENTS.md",
  "apps/**/AGENTS.md",
  "packages/*/AGENTS.md",
  ".agents/skills/*/SKILL.md",
  ".ai/local-skills/*/SKILL.md",
  ".claude/skills/*/SKILL.md",
] as const;

const instructionFiles = (): string[] => {
  const files = new Set<string>();
  for (const pattern of INSTRUCTION_GLOBS) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: REPO_ROOT })) {
      const normalized = file.split(path.sep).join("/");
      if (!normalized.includes("node_modules/")) {
        files.add(normalized);
      }
    }
  }
  return [...files].toSorted();
};

const isAllowlistEntry = (value: unknown): value is AllowlistEntry =>
  isRecord(value) &&
  typeof value["file"] === "string" &&
  typeof value["reference"] === "string" &&
  typeof value["reason"] === "string" &&
  value["reason"].trim().length > 0;

const readAllowlist = (repo: Repo): AllowlistEntry[] => {
  const raw = repo.read(ALLOWLIST_PATH);
  if (raw === undefined) {
    return [];
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isAllowlistEntry)) {
    panic(
      `${ALLOWLIST_PATH} must contain an array of non-empty { file, reference, reason } entries`,
    );
  }
  return parsed;
};

const runCheck = (): number => {
  const repo = diskRepo();
  const files = instructionFiles();
  const found: Problem[] = [];
  for (const file of files) {
    const text = repo.read(file);
    if (text === undefined) {
      continue;
    }
    found.push(...checkFile(repo, file, text));
  }

  const { problems, staleEntries } = applyAllowlist(found, readAllowlist(repo));

  for (const problem of problems) {
    console.error(formatProblem(problem));
  }
  for (const entry of staleEntries) {
    console.error(
      `${ALLOWLIST_PATH}: stale entry ${entry.file} ${entry.reference} (reference now resolves or no longer exists)`,
    );
  }

  if (problems.length > 0 || staleEntries.length > 0) {
    console.error(
      "\ncheck-instruction-references: fix the reference, or add it to " +
        `${ALLOWLIST_PATH} with a reason when it is an intentional example.`,
    );
    return 1;
  }

  console.log(
    `check-instruction-references: OK. ${files.length} instruction file(s) checked.`,
  );
  return 0;
};

// --- Self-test --------------------------------------------------------------

const fixtureRepo = (files: Record<string, string>): Repo => ({
  exists: (repoPath) =>
    Object.keys(files).some(
      (file) => file === repoPath || file.startsWith(`${repoPath}/`),
    ),
  read: (repoPath) => files[repoPath],
});

const SELF_TEST_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    scripts: { verify: "bash scripts/verify.sh" },
  }),
  "apps/api/package.json": JSON.stringify({
    name: "@stll/api",
    scripts: { "db:migrate": "drizzle-kit migrate" },
  }),
  "apps/api/src/lib/csv.ts":
    "export const escapeCSV = (value: string) => value;",
  "apps/api/src/lib/barrel.ts": 'export * from "./csv";',
  "scripts/verify.sh": "#!/usr/bin/env bash\n",
  "scripts/tool.ts": "// tool\n",
  ".oxlint-plugins/no-document-cookie.ts": "// rule\n",
  ".oxlint-plugins/security-guards.ts": "// rules\n",
  "oxlint.config.ts":
    '{ "no-document-cookie/no-document-cookie": "error", "security-guards/no-unscoped-user-query": "error" }',
};

const problemsFor = (text: string): Problem[] =>
  checkFile(fixtureRepo(SELF_TEST_FILES), "FIXTURE.md", text);

const runSelfTest = (): number => {
  const failures: string[] = [];

  const expectClean = (label: string, text: string): void => {
    const problems = problemsFor(text);
    if (problems.length > 0) {
      failures.push(
        `${label}: unexpected ${problems.map(formatProblem).join(", ")}`,
      );
    }
  };

  const expectProblem = (
    label: string,
    text: string,
    kind: ReferenceKind,
  ): void => {
    const problems = problemsFor(text);
    if (!problems.some((problem) => problem.kind === kind)) {
      failures.push(
        `${label}: expected a ${kind} problem, got [${problems.map(formatProblem).join(", ")}]`,
      );
    }
  };

  expectClean("existing path", "Read `scripts/verify.sh` first.");
  expectProblem("missing path", "Read `scripts/gone.sh` first.", "path");
  expectClean("absolute path form", "See `/apps/api/src/lib/csv.ts`.");
  expectClean("glob path is skipped", "Covers `apps/*/src/**/*.ts`.");

  expectClean("root script", "Run `bun run verify`.");
  expectProblem("missing root script", "Run `bun run vermify`.", "command");
  expectClean("workspace script", "Run `bun --filter @stll/api db:migrate`.");
  expectProblem(
    "missing workspace script",
    "Run `bun --filter @stll/api db:seed`.",
    "command",
  );
  expectProblem(
    "unknown workspace",
    "Run `bun --filter @stll/nope db:migrate`.",
    "command",
  );
  expectClean("script file", "Run `bun scripts/tool.ts --check`.");
  expectProblem(
    "missing script file",
    "Run `bun scripts/absent.ts`.",
    "command",
  );

  expectClean("export", "Use `escapeCSV` from `@/api/lib/csv` everywhere.");
  expectProblem(
    "renamed export",
    "Use `escapeCsvCell` from `@/api/lib/csv` everywhere.",
    "export",
  );
  expectProblem(
    "moved module",
    "Use `escapeCSV` from `@/api/lib/formatting` everywhere.",
    "export",
  );
  expectClean(
    "hard-wrapped export form",
    "Use `escapeCSV` from\n`@/api/lib/csv` everywhere.",
  );
  expectClean(
    "re-exported name",
    "Use `escapeCSV` from `@/api/lib/barrel` everywhere.",
  );
  expectClean("unchecked specifier", "Use `useState` from `react`.");

  expectClean(
    "plugin module rule",
    "Enforced by `no-document-cookie/no-document-cookie`.",
  );
  expectClean(
    "registered rule",
    "Enforced by `security-guards/no-unscoped-user-query`.",
  );
  expectProblem(
    "renamed rule",
    "Enforced by `security-guards/no-such-rule`.",
    "rule",
  );
  expectClean("workspace path is not a rule id", "Look in `apps/api`.");
  expectClean(
    "third-party id is not checked",
    "See `react-hooks/rules-of-hooks`.",
  );
  expectClean("placeholder command is skipped", "Run `bun run <script>`.");

  const problem: Problem = {
    file: "FIXTURE.md",
    kind: "path",
    line: 1,
    reference: "apps/example/README.md",
    why: "no such file or directory",
  };
  const suppressed = applyAllowlist(
    [problem],
    [
      {
        file: "FIXTURE.md",
        reference: "apps/example/README.md",
        reason: "example",
      },
    ],
  );
  if (
    suppressed.problems.length !== 0 ||
    suppressed.staleEntries.length !== 0
  ) {
    failures.push("allowlist: a matching entry must suppress its problem");
  }

  const stale = applyAllowlist(
    [],
    [
      {
        file: "FIXTURE.md",
        reference: "apps/example/README.md",
        reason: "example",
      },
    ],
  );
  if (stale.staleEntries.length !== 1) {
    failures.push(
      "allowlist: an entry that suppresses nothing must fail as stale",
    );
  }

  if (failures.length > 0) {
    console.error("check-instruction-references --self-test: FAIL");
    for (const failure of failures) {
      console.error(`  ${failure}`);
    }
    return 1;
  }
  console.log("check-instruction-references --self-test: PASS");
  return 0;
};

// --- Entry ------------------------------------------------------------------

const main = (): number => {
  const args = process.argv.slice(2);
  for (const argument of args) {
    if (argument !== "--self-test" && argument !== "--check") {
      panic(`Unknown argument: ${argument}`);
    }
  }
  return args.includes("--self-test") ? runSelfTest() : runCheck();
};

if (import.meta.main) {
  // Set exitCode rather than process.exit() so stdout/stderr flush before exit.
  process.exitCode = main();
}
