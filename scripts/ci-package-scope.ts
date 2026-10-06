import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import { GENERATORS } from "./generated-files";
import {
  landingBuildRootInputs,
  landingClosure,
  parseLockfile,
} from "./landing-deploy-scope";
import {
  readCallArguments,
  readLiteralCallOptions,
  readStringLiterals,
  readTestInputs,
} from "./test-input-readers";

const ROOT = path.resolve(import.meta.dir, "..");
const GLOBAL =
  /(?:^|\/)(?:package\.json|tsconfig[^/]*|bun\.lockb?|bunfig\.toml|\.npmrc|turbo\.json)$|^(?:patches|\.github)\//u;
const CONTENT =
  /^(?:\.ai|\.agents|\.claude)\/|(?:^|\/)(?:AGENTS|GEMINI|SKILL)\.md$|^docs\/(?:changelog|policies)\//u;
const MARKDOWN = /\.mdx?$/u;
const PROVENANCE = /^(?:\.provenance\.yml$|provenance\/)/u;

const matches = (file: string, pattern: string) =>
  file === pattern || new Bun.Glob(pattern).match(file);

class MarkdownReaderDeclarationError extends Error {
  override name = "MarkdownReaderDeclarationError";
  readonly _tag = "MarkdownReaderDeclarationError";
}

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
      .scanImports(source)
      .some(({ path: imported }) => imported === "astro/loaders");
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
    if (options?.size === 2 && pattern !== undefined && base !== undefined) {
      patterns.push(path.posix.join(workspace, base, pattern));
    } else {
      throw new MarkdownReaderDeclarationError(
        `${file}: Astro glob must declare a literal Markdown pattern and base`,
      );
    }
  });
  if (calls === 0) {
    throw new MarkdownReaderDeclarationError(
      `${file}: Astro Markdown reader has no resolvable glob call`,
    );
  }
  return patterns;
};

type MarkdownReader = {
  file: string;
  inputs: readonly string[];
} & (
  | { kind: "module" }
  | { kind: "check"; command: readonly string[] }
  | { kind: "unresolved" }
);

const READ_CALLS = new Set(["readFileSync", "readFile"]);
const DIRECTORY_CALLS = new Set(["readdirSync", "readdir", "Glob"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

// Resolve the path expression that a read actually receives. Fixture strings,
// output names, and external specification names never enter this walk.
const pathExpression = (
  expression: string,
  source: string,
  file: string,
  seen = new Set<string>(),
): string | undefined => {
  const text = expression.trim();
  if (text === "import.meta.dir" || text === "import.meta.dirname") {
    return path.posix.dirname(file);
  }
  if (text === "process.cwd()" || text === "root") {
    return ".";
  }
  if (IDENTIFIER.test(text)) {
    if (seen.has(text)) {
      return undefined;
    }
    seen.add(text);
    const declaration = new RegExp(`\\bconst\\s+${text}\\b`, "u").exec(source);
    if (!declaration) {
      return undefined;
    }
    const start =
      source.indexOf("=", declaration.index + declaration[0].length) + 1;
    if (start === 0) {
      return undefined;
    }
    const end = source.indexOf(";", start);
    if (end === -1) {
      return undefined;
    }
    return pathExpression(source.slice(start, end), source, file, seen);
  }
  const literal = readStringLiterals(text);
  if (
    (text.startsWith('"') || text.startsWith("'")) &&
    literal.length === 1 &&
    text.at(-1) === text.at(0)
  ) {
    return literal.at(0)?.value;
  }
  const open = text.indexOf("(");
  if (open === -1 || !text.endsWith(")")) {
    return undefined;
  }
  const callee = text.slice(0, open).trim();
  const args = readCallArguments(text.slice(open));
  if (callee === "new URL" && args.at(1) === "import.meta.url") {
    const target = args.at(0);
    const value =
      target === undefined
        ? undefined
        : pathExpression(target, source, file, seen);
    return value === undefined
      ? undefined
      : path.posix.join(path.posix.dirname(file), value);
  }
  if (!["join", "resolve"].includes(callee.split(".").at(-1) ?? "")) {
    return undefined;
  }
  const parts: string[] = [];
  for (const arg of args) {
    const value = pathExpression(arg, source, file, new Set(seen));
    if (value === undefined) {
      return undefined;
    }
    parts.push(value);
  }
  return path.posix.join(...parts);
};

const readerCommand = (
  root: string,
  file: string,
): readonly string[] | undefined => {
  if (file.startsWith("scripts/") && /\.test\.[cm]?[jt]sx?$/u.test(file)) {
    return ["bun", "test", file];
  }
  const packageFile = path.join(root, "package.json");
  if (!existsSync(packageFile)) {
    return undefined;
  }
  const config: unknown = JSON.parse(readFileSync(packageFile, "utf-8"));
  if (typeof config !== "object" || config === null || !("scripts" in config)) {
    return undefined;
  }
  const scripts = config.scripts;
  if (typeof scripts !== "object" || scripts === null) {
    return undefined;
  }
  // Only direct commands qualify: a chained package script may run unrelated
  // generators or write files. A computed command needs an owner declaration.
  for (const command of Object.values(scripts)) {
    if (typeof command !== "string") {
      continue;
    }
    const words = command.trim().split(/\s+/u);
    if (
      words.at(0) === "bun" &&
      words.at(1) === file &&
      words.every((word) => !/[;&|$`]/u.test(word))
    ) {
      return words;
    }
  }
  return undefined;
};

const sourceFiles = (root: string): readonly string[] => {
  // Tracked sources avoid traversing installed dependency trees. Temporary
  // repositories in selector tests have no Git metadata and use a small glob.
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tracked.exitCode === 0) {
    return tracked.stdout
      .toString()
      .split("\0")
      .filter(
        (file) =>
          /^(?:scripts|apps|packages|\.oxlint-plugins|\.claude)\//u.test(
            file,
          ) && /\.[cm]?[jt]sx?$/u.test(file),
      );
  }
  return [
    ...new Bun.Glob(
      "{scripts,apps,packages,.oxlint-plugins,.claude}/**/*.{ts,tsx,js,mjs,cjs}",
    ).scanSync({ cwd: root, onlyFiles: true }),
  ];
};

const filesystemReadBindings = (source: string) => {
  const reads = new Set(READ_CALLS);
  for (const match of source.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/gu,
  )) {
    for (const binding of (match[1] ?? "").split(",")) {
      const [name, alias] = binding.trim().split(/\s+as\s+/u);
      if (READ_CALLS.has(name ?? "")) {
        reads.add(alias ?? name ?? "");
      }
    }
  }
  for (const match of source.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*=/gu)) {
    const start = match.index + match[0].length;
    const end = source.indexOf(";", start);
    const body = source.slice(start, end === -1 ? source.length : end);
    if (
      body.includes("=>") &&
      [...reads].some((name) => body.includes(`${name}(`))
    ) {
      reads.add(match[1] ?? "");
    }
  }
  return reads;
};

// These existing policy guards run after install independently of package
// scope. Derive their commands from the owning workflow, so the docs job cannot
// drift from their normal CI execution or omit a newly added policy guard.
const markdownPolicyReaders = (root: string): readonly MarkdownReader[] => {
  const workflowFile = path.join(root, ".github/workflows/ci.yml");
  if (!existsSync(workflowFile)) {
    return [];
  }
  const workflow: unknown = Bun.YAML.parse(readFileSync(workflowFile, "utf-8"));
  if (
    typeof workflow !== "object" ||
    workflow === null ||
    !("jobs" in workflow)
  ) {
    throw new MarkdownReaderDeclarationError(
      ".github/workflows/ci.yml: missing policy job declarations",
    );
  }
  const jobs = workflow.jobs;
  if (
    typeof jobs !== "object" ||
    jobs === null ||
    !("ci-checks-policy" in jobs)
  ) {
    throw new MarkdownReaderDeclarationError(
      ".github/workflows/ci.yml: missing ci-checks-policy",
    );
  }
  const job = jobs["ci-checks-policy"];
  if (
    typeof job !== "object" ||
    job === null ||
    !("steps" in job) ||
    !Array.isArray(job.steps)
  ) {
    throw new MarkdownReaderDeclarationError(
      ".github/workflows/ci.yml: missing policy steps",
    );
  }
  const readers: MarkdownReader[] = [];
  for (const step of job.steps) {
    if (
      typeof step !== "object" ||
      step === null ||
      !("if" in step) ||
      !("run" in step) ||
      typeof step.if !== "string" ||
      typeof step.run !== "string"
    ) {
      continue;
    }
    if (
      !step.if.includes("steps.install.outcome == 'success'") ||
      step.if.includes("package_checks_required")
    ) {
      continue;
    }
    if (!("name" in step) || typeof step.name !== "string") {
      throw new MarkdownReaderDeclarationError(
        ".github/workflows/ci.yml: policy reader has no name",
      );
    }
    readers.push({
      file: `.github/workflows/ci.yml:ci-checks-policy:${step.name}`,
      kind: "check",
      inputs: ["**/*.md", "**/*.mdx"],
      command: ["bash", "-e", "-c", step.run],
    });
  }
  return readers;
};

export const markdownReaders = (root = ROOT): readonly MarkdownReader[] => {
  const readers: MarkdownReader[] = [...markdownPolicyReaders(root)];
  for (const file of sourceFiles(root)) {
    const source = readFileSync(path.join(root, file), "utf-8").replace(
      /^#![^\n]*/u,
      "",
    );
    if (
      !/\b(?:readFileSync|readFile|readText|readdirSync|readdir|spawnSync|Bun\.(?:file|Glob))\b/u.test(
        source,
      ) &&
      !source.includes("astro/loaders") &&
      !/\b(?:from|import)\s*["'][^"'\n]+\.mdx?["']/u.test(source)
    ) {
      continue;
    }
    const imports = new Bun.Transpiler({
      loader: file.endsWith("tsx") || file.endsWith("jsx") ? "tsx" : "ts",
    }).scanImports(source);
    const inputs = new Set<string>();
    let moduleInput = false;
    for (const { path: imported } of imports) {
      if (MARKDOWN.test(imported) && imported.startsWith(".")) {
        inputs.add(path.posix.join(path.posix.dirname(file), imported));
        moduleInput = true;
      }
    }
    const loaderInputs = astroMarkdownInputs(source, file);
    if (loaderInputs !== undefined) {
      for (const input of loaderInputs) {
        inputs.add(input);
      }
      moduleInput = true;
    }
    const importsFs = imports.some(({ path: imported }) =>
      ["node:fs", "node:fs/promises", "fs", "fs/promises"].includes(imported),
    );
    const reads = importsFs ? filesystemReadBindings(source) : READ_CALLS;
    readStringLiterals(source, (callee, call, start) => {
      if (callee === undefined) {
        return;
      }
      const prefix = source.slice(Math.max(0, start - 30), start);
      const isBunFile = callee === "file" && prefix.endsWith("Bun.file");
      const isGlob = callee === "Glob" && prefix.endsWith("Bun.Glob");
      const isRead =
        callee === "file" ? isBunFile : reads.has(callee) && importsFs;
      const isDirectory = DIRECTORY_CALLS.has(callee) && (importsFs || isGlob);
      if (isRead || isDirectory) {
        const argument = readCallArguments(call).at(0);
        if (argument === undefined) {
          return;
        }
        const target = pathExpression(argument, source, file);
        if (
          target !== undefined &&
          !target.includes("\n") &&
          (MARKDOWN.test(target) || (isDirectory && target.startsWith("docs/")))
        ) {
          inputs.add(
            isDirectory && !target.includes("*")
              ? `${target}/**`
              : target.replace(/^(?:\.\.\/)+/u, ""),
          );
        } else if (
          target === undefined &&
          readStringLiterals(argument).some(({ value }) => MARKDOWN.test(value))
        ) {
          throw new MarkdownReaderDeclarationError(
            `${file}: Markdown read has an unresolved path expression: ${argument}`,
          );
        }
      }
      // Git's unanchored pathspec *.md reaches every tracked directory, unlike
      // Bun.Glob. Require the actual git grep argv, not a fixture's *.md string.
      if (callee === "spawnSync") {
        const values = readStringLiterals(call).map(({ value }) => value);
        if (values.at(0) === "git" && values.at(1) === "grep") {
          for (const value of values) {
            if (MARKDOWN.test(value)) {
              inputs.add(value.startsWith("*.") ? `**/${value}` : value);
            }
          }
        }
      }
    });
    if (inputs.size > 0) {
      const command = readerCommand(root, file);
      const reader = { file, inputs: [...inputs] };
      if (moduleInput || /^(?:apps|packages)\//u.test(file)) {
        readers.push({ ...reader, kind: "module" });
      } else if (command !== undefined) {
        readers.push({ ...reader, kind: "check", command });
      } else {
        readers.push({ ...reader, kind: "unresolved" });
      }
    }
  }
  for (const [owner, inputs] of readTestInputs(root)) {
    const markdown = inputs.filter(
      (input) => MARKDOWN.test(input) || input.startsWith("docs/"),
    );
    if (markdown.length > 0) {
      readers.push({
        file: `test-input:${owner}`,
        inputs: markdown,
        kind: "module",
      });
    }
  }
  // Explicit Markdown generator inputs/outputs are semantic contracts. Broad
  // source-tree cache inputs are not evidence that a generator reads Markdown.
  for (const generator of GENERATORS) {
    const inputs = [...generator.inputs, ...generator.outputs].filter((input) =>
      MARKDOWN.test(input),
    );
    if (inputs.length > 0) {
      readers.push({
        file: `generator:${generator.id}`,
        inputs,
        kind: "module",
      });
    }
  }
  return readers;
};

export const markdownChecks = ({
  changed,
  root = ROOT,
}: ScopeOptions): readonly (readonly string[])[] => {
  const checks = new Map<string, readonly string[]>();
  for (const reader of markdownReaders(root)) {
    if (
      !changed.some((file) =>
        reader.inputs.some((input) => matches(file, input)),
      )
    ) {
      continue;
    }
    if (reader.kind !== "check") {
      throw new MarkdownReaderDeclarationError(
        `${reader.file}: Markdown consumer has no isolated check command`,
      );
    }
    checks.set(JSON.stringify(reader.command), reader.command);
  }
  return [...checks.values()];
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
    for (const reader of markdownReaders(root)) {
      if (
        !documents.some((file) =>
          reader.inputs.some((input) => matches(file, input)),
        )
      ) {
        continue;
      }
      if (reader.kind === "unresolved") {
        throw new MarkdownReaderDeclarationError(
          `${reader.file}: Markdown consumer has no isolated check command`,
        );
      }
      if (reader.kind === "module") {
        return true;
      }
    }
    return false;
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
  } else if (kind === "--run-markdown-checks") {
    const files: unknown = JSON.parse(
      process.env["CHANGED_MARKDOWN"] ?? "null",
    );
    if (
      !Array.isArray(files) ||
      !files.every((file) => typeof file === "string" && MARKDOWN.test(file))
    ) {
      throw new MarkdownReaderDeclarationError(
        "Changed Markdown must be a JSON array of Markdown paths",
      );
    }
    for (const command of markdownChecks({ changed: files })) {
      console.log(`Markdown consumer: ${command.join(" ")}`);
      const result = Bun.spawnSync([...command], {
        cwd: ROOT,
        stdout: "inherit",
        stderr: "inherit",
      });
      if (childExitStatus(result) !== 0) {
        process.exit(childExitStatus(result));
      }
    }
    process.exit(0);
  } else if (kind === "--markdown-checks") {
    console.log(JSON.stringify(markdownChecks({ changed })));
    process.exit(0);
  } else if (kind === "--landing-build") {
    required = requiresLandingBuild({ changed });
  }
  console.log(String(required));
}
