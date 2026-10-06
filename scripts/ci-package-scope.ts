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
  maskSourceNonCode,
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

const READER_PACKAGE_CHECKS = {
  module: true,
  check: false,
  unresolved: true,
} as const satisfies Record<MarkdownReader["kind"], boolean>;

const READ_CALLS = new Set(["readFileSync", "readFile"]);
const DIRECTORY_CALLS = new Set(["readdirSync", "readdir", "Glob"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

type PathExpressionOptions = {
  expression: string;
  code: string;
  source: string;
  file: string;
  seen?: Set<string>;
  temporaryFactories: ReadonlySet<string>;
};
type PathExpressionResult =
  | { kind: "repository"; value: string }
  | { kind: "external" }
  | { kind: "unresolved"; prefix?: string };

type IdentifierPathOptions = PathExpressionOptions & {
  resolve: (options: PathExpressionOptions) => PathExpressionResult;
};

const identifierExpressions = ({
  expression: text,
  code,
  source,
}: Pick<PathExpressionOptions, "expression" | "code" | "source">):
  | readonly string[]
  | undefined => {
  const expressions: string[] = [];
  for (const declaration of code.matchAll(
    new RegExp(`\\bconst\\s+${text}\\b`, "gu"),
  )) {
    const tail = source
      .slice(declaration.index + declaration[0].length)
      .trimStart();
    if (!tail.startsWith("=") && !tail.startsWith(":")) {
      continue;
    }
    const start =
      code.indexOf("=", declaration.index + declaration[0].length) + 1;
    const end = code.indexOf(";", start);
    if (start === 0 || end === -1) {
      return undefined;
    }
    expressions.push(source.slice(start, end));
  }
  return expressions;
};

type ExpressionReferenceOptions = Pick<
  PathExpressionOptions,
  "expression" | "code" | "source" | "seen"
> & {
  matchesExpression: (expression: string) => boolean;
  root?: string | undefined;
  file?: string | undefined;
};

type ImportedConstantOptions = {
  root: string;
  file: string;
  source: string;
  code: string;
  name: string;
};
const importedConstants = ({
  root,
  file,
  source,
  code,
  name,
}: ImportedConstantOptions) => {
  const constants: {
    expression: string;
    source: string;
    code: string;
    file: string;
  }[] = [];
  for (const declaration of source.matchAll(
    /\bimport\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/gu,
  )) {
    if (!code.slice(declaration.index).startsWith("import")) {
      continue;
    }
    for (const binding of (declaration[1] ?? "").split(",")) {
      const [original, separator, alias] = binding.trim().split(/\s+/u);
      if (
        (separator === "as" ? alias : original) !== name ||
        original === undefined
      ) {
        continue;
      }
      const target = path.posix.join(
        path.posix.dirname(file),
        declaration[2] ?? "",
      );
      if (target.startsWith("../")) {
        continue;
      }
      const importedFile = [
        target,
        ...[".ts", ".tsx", ".js", ".mjs", ".cjs"].map(
          (extension) => `${target}${extension}`,
        ),
      ].find(
        (candidate) =>
          path.posix.extname(candidate) !== "" &&
          existsSync(path.join(root, candidate)),
      );
      if (importedFile === undefined) {
        continue;
      }
      const importedSource = readFileSync(
        path.join(root, importedFile),
        "utf-8",
      );
      constants.push({
        expression: original,
        source: importedSource,
        code: maskSourceNonCode(importedSource),
        file: importedFile,
      });
    }
  }
  return constants;
};

const expressionReferences = ({
  expression,
  code,
  source,
  seen = new Set<string>(),
  matchesExpression,
  root,
  file,
}: ExpressionReferenceOptions): boolean => {
  if (matchesExpression(expression)) {
    return true;
  }
  for (const identifier of maskSourceNonCode(expression).matchAll(
    /\b[A-Za-z_$][\w$]*\b/gu,
  )) {
    const name = identifier[0];
    const key = `${file ?? ""}#${name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const initializers = identifierExpressions({
      expression: name,
      code,
      source,
    });
    if (
      initializers?.some((initializer) =>
        expressionReferences({
          expression: initializer,
          code,
          source,
          seen,
          matchesExpression,
          root,
          file,
        }),
      )
    ) {
      return true;
    }
    if (root !== undefined && file !== undefined) {
      for (const imported of importedConstants({
        root,
        file,
        source,
        code,
        name,
      })) {
        if (
          expressionReferences({ ...imported, root, seen, matchesExpression })
        ) {
          return true;
        }
      }
    }
  }
  return false;
};

const identifierPath = ({
  expression: text,
  resolve,
  code,
  source,
  file,
  temporaryFactories,
  seen = new Set<string>(),
}: IdentifierPathOptions): PathExpressionResult => {
  if (seen.has(text)) {
    return { kind: "unresolved" };
  }
  seen.add(text);
  const results: PathExpressionResult[] = [];
  const expressions = identifierExpressions({ expression: text, code, source });
  if (expressions === undefined) {
    return { kind: "unresolved" };
  }
  for (const expression of expressions) {
    // Plain object and array constants cannot be filesystem path arguments.
    // Identically named data in another scope must not obscure a real path.
    if (/^[{[]/u.test(expression.trim())) {
      continue;
    }
    results.push(
      resolve({
        expression,
        code,
        source,
        file,
        seen: new Set(seen),
        temporaryFactories,
      }),
    );
  }
  const [first, ...rest] = results;
  if (
    first === undefined ||
    rest.some((result) => JSON.stringify(result) !== JSON.stringify(first))
  ) {
    return { kind: "unresolved" };
  }
  return first;
};

const memberPath = (options: PathExpressionOptions): PathExpressionResult => {
  const [object, property] = options.expression.split(".");
  if (object === undefined || property === undefined) {
    return { kind: "unresolved" };
  }
  return identifierPath({
    ...options,
    expression: object,
    resolve: ({ expression: initializer }) => {
      const value = initializer.trim();
      const open = value.indexOf("(");
      if (open === -1) {
        return { kind: "unresolved" };
      }
      return options.temporaryFactories.has(
        `${value.slice(0, open)}.${property}`,
      )
        ? { kind: "external" }
        : { kind: "unresolved" };
    },
  });
};

// Resolve the expression a read actually receives. Temporary fixture roots
// stay outside the repository; their Markdown files are not CI source inputs.
const pathExpression = ({
  expression,
  code,
  source,
  file,
  seen = new Set<string>(),
  temporaryFactories,
}: PathExpressionOptions): PathExpressionResult => {
  const text = expression.trim();
  if (text === "import.meta.dir" || text === "import.meta.dirname") {
    return { kind: "repository", value: path.posix.dirname(file) };
  }
  if (text === "process.cwd()") {
    return { kind: "repository", value: "." };
  }
  if (IDENTIFIER.test(text)) {
    return identifierPath({
      resolve: pathExpression,
      expression: text,
      code,
      source,
      file,
      temporaryFactories,
      seen,
    });
  }
  if (/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/u.test(text)) {
    return memberPath({
      expression: text,
      code,
      source,
      file,
      temporaryFactories,
      seen,
    });
  }
  const literal = readStringLiterals(text);
  const value = literal.at(0)?.value;
  if (
    (text.startsWith('"') || text.startsWith("'") || text.startsWith("`")) &&
    literal.length === 1 &&
    text.at(-1) === text.at(0) &&
    value !== undefined
  ) {
    return { kind: "repository", value };
  }
  const open = text.indexOf("(");
  if (open === -1 || !text.endsWith(")")) {
    return { kind: "unresolved" };
  }
  const callee = text.slice(0, open).trim();
  const args = readCallArguments(text.slice(open));
  if (
    ["mkdtempSync", "mkdtemp", "tmpdir"].includes(callee) ||
    temporaryFactories.has(callee)
  ) {
    return { kind: "external" };
  }
  if (callee === "fileURLToPath") {
    const target = args.at(0);
    return target === undefined
      ? { kind: "unresolved" }
      : pathExpression({
          expression: target,
          code,
          source,
          file,
          temporaryFactories,
          seen,
        });
  }
  if (callee === "new URL" && args.at(1) === "import.meta.url") {
    const target = args.at(0);
    if (target === undefined) {
      return { kind: "unresolved" };
    }
    const resolved = pathExpression({
      expression: target,
      code,
      source,
      file,
      seen,
      temporaryFactories,
    });
    if (resolved.kind !== "repository") {
      return resolved;
    }
    return {
      kind: "repository",
      value: path.posix.join(path.posix.dirname(file), resolved.value),
    };
  }
  if (!["join", "resolve"].includes(callee.split(".").at(-1) ?? "")) {
    return { kind: "unresolved" };
  }
  const parts: string[] = [];
  for (const arg of args) {
    const resolved = pathExpression({
      expression: arg,
      code,
      source,
      file,
      seen: new Set(seen),
      temporaryFactories,
    });
    if (resolved.kind !== "repository") {
      if (resolved.kind === "unresolved" && parts.length > 0) {
        return { kind: "unresolved", prefix: path.posix.join(...parts) };
      }
      return resolved;
    }
    parts.push(resolved.value);
  }
  return { kind: "repository", value: path.posix.join(...parts) };
};

const declaredMarkdownInputs = (
  options: PathExpressionOptions,
): readonly string[] | undefined => {
  const { expression, source, code, file } = options;
  const text = expression.trim();
  if (text.startsWith("[")) {
    const end = text.lastIndexOf("]");
    const tail = text.slice(end + 1).trim();
    if (end === -1 || (tail !== "" && tail !== "as const")) {
      throw new MarkdownReaderDeclarationError(
        `${file}: Markdown reader inputs must be a static path list`,
      );
    }
    return readCallArguments(`(${text.slice(1, end)})`).map((entry) => {
      const codeExpression = maskSourceNonCode(entry).trim();
      const literals = readStringLiterals(entry);
      let input = entry;
      if (IDENTIFIER.test(codeExpression)) {
        input = codeExpression;
      } else if (codeExpression === "" && literals.length === 1) {
        input = JSON.stringify(literals.at(0)?.value);
      }
      const resolved = pathExpression({ ...options, expression: input });
      if (resolved.kind !== "repository") {
        throw new MarkdownReaderDeclarationError(
          `${file}: Markdown reader input is unresolved: ${entry}`,
        );
      }
      return resolved.value.includes("*") ||
        path.posix.extname(resolved.value) !== ""
        ? resolved.value
        : `${resolved.value}/**`;
    });
  }
  if (!IDENTIFIER.test(text) || options.seen?.has(text)) {
    throw new MarkdownReaderDeclarationError(
      `${file}: Markdown reader input declaration is unresolved: ${text}`,
    );
  }
  const seen = new Set(options.seen);
  seen.add(text);
  const expressions = identifierExpressions({ expression: text, code, source });
  const results = expressions?.map((value) =>
    declaredMarkdownInputs({ ...options, expression: value, seen }),
  );
  const first = results?.at(0);
  if (first === undefined) {
    return undefined;
  }
  if (
    results?.some((value) => JSON.stringify(value) !== JSON.stringify(first))
  ) {
    throw new MarkdownReaderDeclarationError(
      `${file}: Markdown reader declarations disagree: ${text}`,
    );
  }
  return first;
};

type GlobPathResult =
  | PathExpressionResult
  | { kind: "declared"; inputs: readonly string[] };

type GlobPathOptions = PathExpressionOptions & {
  target: string;
  call: string;
  start: number;
};
const globPath = ({
  target,
  call,
  start,
  source,
  code,
  file,
  temporaryFactories,
}: GlobPathOptions): GlobPathResult => {
  const extension = target.slice(target.lastIndexOf(".") + 1);
  if (
    /^(?:[A-Za-z0-9]+|\{[A-Za-z0-9,]+\})$/u.test(extension) &&
    !extension
      .replaceAll(/[{}]/gu, "")
      .split(",")
      .some((value) => value === "md" || value === "mdx")
  ) {
    return { kind: "external" };
  }
  const scan = /^\s*\.scan(?:Sync)?\s*\(/u.exec(
    source.slice(start + call.length),
  );
  if (scan === null) {
    return { kind: "repository", value: target };
  }
  const options = readCallArguments(
    source.slice(start + call.length + scan[0].length - 1),
  ).at(0);
  const optionText = options?.trim() ?? "";
  const objectOptions = optionText.startsWith("{") && optionText.endsWith("}");
  const fields = objectOptions
    ? readCallArguments(`(${optionText.slice(1, -1)})`)
    : [];
  const staticOptions =
    objectOptions &&
    fields.every((field) => /^[A-Za-z_$][\w$]*(?:\s*:|$)/u.test(field.trim()));
  const cwd = fields.find((field) => /^\s*cwd(?:\s*:|\s*$)/u.test(field));
  if (options === undefined || (staticOptions && cwd === undefined)) {
    return { kind: "repository", value: target };
  }
  let directoryExpression = "<unresolved scan options>";
  if (staticOptions && cwd !== undefined) {
    const colon = cwd.indexOf(":");
    directoryExpression = cwd.slice(colon === -1 ? 0 : colon + 1);
  }
  const directory = pathExpression({
    expression: directoryExpression,
    code,
    source,
    file,
    temporaryFactories,
  });
  if (directory.kind === "repository") {
    return {
      kind: "repository",
      value: path.posix.join(directory.value, target),
    };
  }
  if (directory.kind === "external" || directory.prefix !== undefined) {
    return directory;
  }
  const inputs = declaredMarkdownInputs({
    expression: "CI_MARKDOWN_READER_INPUTS",
    code,
    source,
    file,
    temporaryFactories,
  });
  if (inputs !== undefined && inputs.length > 0) {
    return { kind: "declared", inputs };
  }
  throw new MarkdownReaderDeclarationError(
    `${file}: Markdown glob scan has an unresolved cwd; declare CI_MARKDOWN_READER_INPUTS`,
  );
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
  for (const [name, command] of Object.entries(scripts)) {
    if (!name.startsWith("check:") || typeof command !== "string") {
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
  // Gitlinks belong to a separate source repository. An exported checkout
  // must enumerate the same first-party files as git ls-files above.
  const modules = path.join(root, ".gitmodules");
  const gitlinks = existsSync(modules)
    ? readFileSync(modules, "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("path ="))
        .map((line) => line.slice("path =".length).trim())
    : [];
  return [
    ...new Bun.Glob(
      "{scripts,apps,packages,.oxlint-plugins,.claude}/**/*.{ts,tsx,js,mjs,cjs}",
    ).scanSync({ cwd: root, onlyFiles: true }),
  ].filter(
    (file) => !gitlinks.some((gitlink) => file.startsWith(`${gitlink}/`)),
  );
};

const sourceFunctionBodies = (code: string) => {
  const functions: {
    name: string;
    body: string;
    parameter: string | undefined;
  }[] = [];
  for (const match of code.matchAll(
    /\b(?:function|const)\s+([A-Za-z_$][\w$]*)/gu,
  )) {
    const start = match.index + match[0].length;
    const tail = code.slice(start);
    let bodyStart: number;
    if (match[0].startsWith("const")) {
      const arrow = tail.indexOf("=>");
      const end = tail.indexOf(";");
      if (arrow === -1 || (end !== -1 && arrow > end)) {
        continue;
      }
      bodyStart = start + arrow + 2;
    } else {
      bodyStart = code.indexOf("{", start);
    }
    while (/\s/u.test(code.charAt(bodyStart)) && bodyStart < code.length) {
      bodyStart += 1;
    }
    if (bodyStart === -1) {
      continue;
    }
    let end = code.indexOf(";", bodyStart);
    if (code.charAt(bodyStart) === "{") {
      let depth = 1;
      end = bodyStart + 1;
      while (end < code.length && depth > 0) {
        if (code.charAt(end) === "{") {
          depth += 1;
        } else if (code.charAt(end) === "}") {
          depth -= 1;
        }
        end += 1;
      }
    }
    functions.push({
      name: match[1] ?? "",
      parameter:
        code.slice(start, bodyStart).match(/\(\s*([A-Za-z_$][\w$]*)\b/u)?.[1] ??
        code
          .slice(start, bodyStart)
          .match(/[=]\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/u)?.[1],
      body: code.slice(bodyStart, end === -1 ? code.length : end),
    });
  }
  return functions;
};

const temporaryPathFactories = (code: string) => {
  const factories = new Set<string>();
  for (const { name, body } of sourceFunctionBodies(code)) {
    const returns = [...body.matchAll(/\breturn\s+([A-Za-z_$][\w$]*)\s*;/gu)];
    const objects = [...body.matchAll(/\breturn\s*\{([^{}]*)\}\s*;/gu)];
    if (
      objects.length > 0 &&
      objects.length === [...body.matchAll(/\breturn\b/gu)].length
    ) {
      const fields = readCallArguments(`(${objects.at(0)?.[1] ?? ""})`);
      for (const field of fields) {
        const property = field.trim();
        if (
          !IDENTIFIER.test(property) ||
          !objects.every((object) =>
            readCallArguments(`(${object[1] ?? ""})`).some(
              (value) => value.trim() === property,
            ),
          )
        ) {
          continue;
        }
        const declarations = [
          ...body.matchAll(new RegExp(`\\bconst\\s+${property}\\s*=`, "gu")),
        ];
        if (
          declarations.length > 0 &&
          declarations.every((declaration) =>
            /^\s*mkdtemp(?:Sync)?\s*\(/u.test(
              body.slice(declaration.index + declaration[0].length),
            ),
          )
        ) {
          factories.add(`${name}.${property}`);
        }
      }
    }
    if (
      returns.length === 0 ||
      returns.length !== [...body.matchAll(/\breturn\b/gu)].length
    ) {
      continue;
    }
    if (
      returns.every((match) => {
        const declarations = [
          ...body.matchAll(
            new RegExp(`\\bconst\\s+${match[1] ?? ""}\\s*=`, "gu"),
          ),
        ];
        return (
          declarations.length > 0 &&
          declarations.every((declaration) =>
            /^\s*mkdtemp(?:Sync)?\s*\(/u.test(
              body.slice(declaration.index + declaration[0].length),
            ),
          )
        );
      })
    ) {
      factories.add(name);
    }
  }
  return factories;
};

const filesystemReadBindings = (source: string, code: string) => {
  const reads = new Set(READ_CALLS);
  for (const match of source.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/gu,
  )) {
    if (!code.slice(match.index).startsWith("import")) {
      continue;
    }
    for (const binding of (match[1] ?? "").split(",")) {
      const [name, separator, alias] = binding.trim().split(/\s+/u);
      if (READ_CALLS.has(name ?? "")) {
        reads.add(separator === "as" ? (alias ?? "") : (name ?? ""));
      }
    }
  }
  for (const { name, body, parameter } of sourceFunctionBodies(code)) {
    if (parameter === undefined) {
      continue;
    }
    const forwarded = [...reads].some((read) =>
      [...body.matchAll(new RegExp(`\\b${read}\\s*\\(`, "gu"))].some((call) => {
        const argument = readCallArguments(
          body.slice(call.index + read.length),
        ).at(0);
        return (
          argument !== undefined &&
          expressionReferences({
            expression: argument,
            code,
            source,
            matchesExpression: (value) =>
              new RegExp(`\\b${parameter}\\b`, "u").test(
                maskSourceNonCode(value),
              ),
          })
        );
      }),
    );
    if (forwarded) {
      reads.add(name);
    }
  }
  return reads;
};

const markdownPolicyReader = (step: unknown): MarkdownReader | undefined => {
  if (
    typeof step !== "object" ||
    step === null ||
    !("if" in step) ||
    !("run" in step) ||
    typeof step.if !== "string" ||
    typeof step.run !== "string"
  ) {
    return undefined;
  }
  if (
    !step.if.includes("steps.install.outcome == 'success'") ||
    step.if.includes("package_checks_required")
  ) {
    return undefined;
  }
  if (!("name" in step) || typeof step.name !== "string") {
    throw new MarkdownReaderDeclarationError(
      ".github/workflows/ci.yml: policy reader has no name",
    );
  }
  return {
    file: `.github/workflows/ci.yml:ci-checks-policy:${step.name}`,
    kind: "check",
    inputs: ["**/*.md", "**/*.mdx"],
    command: ["bash", "-e", "-c", step.run],
  };
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
    const reader = markdownPolicyReader(step);
    if (reader !== undefined) {
      readers.push(reader);
    }
  }
  return readers;
};

// Git's unanchored pathspec *.md reaches every tracked directory.
const gitMarkdownInputs = (callee: string, call: string): readonly string[] => {
  if (callee !== "spawnSync") {
    return [];
  }
  const values = readStringLiterals(call).map(({ value }) => value);
  if (values.at(0) !== "git" || values.at(1) !== "grep") {
    return [];
  }
  return values
    .filter((value) => MARKDOWN.test(value))
    .map((value) => (value.startsWith("*.") ? `**/${value}` : value));
};

type UnresolvedReadOptions = PathExpressionOptions & {
  policyReaders: readonly MarkdownReader[];
};
const unresolvedReadInputs = ({
  policyReaders,
  ...options
}: UnresolvedReadOptions): readonly string[] => {
  // Existing unconditional policy checks declare all Markdown inputs and
  // execute the same reader in the docs job.
  if (
    policyReaders.some(
      (reader) =>
        reader.kind === "check" &&
        reader.command.some((part) =>
          part.split(/\s+/u).includes(options.file),
        ),
    )
  ) {
    return [];
  }
  const inputs = declaredMarkdownInputs({
    ...options,
    expression: "CI_MARKDOWN_READER_INPUTS",
  });
  if (inputs !== undefined && inputs.length > 0) {
    return inputs;
  }
  throw new MarkdownReaderDeclarationError(
    `${options.file}: Markdown read has an unresolved path expression: ${options.expression}`,
  );
};

let rootReaders: readonly MarkdownReader[] | undefined;
export const markdownReaders = (root = ROOT): readonly MarkdownReader[] => {
  // The tracked checkout is fixed during a planning process; fixture roots
  // remain uncached so tests and callers can change their declarations.
  if (root === ROOT && rootReaders !== undefined) {
    return rootReaders;
  }
  const policyReaders = markdownPolicyReaders(root);
  const readers: MarkdownReader[] = [...policyReaders];
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
    const unresolvedInputs = new Set<string>();
    for (const { path: imported } of imports) {
      if (MARKDOWN.test(imported)) {
        if (!imported.startsWith(".")) {
          throw new MarkdownReaderDeclarationError(
            `${file}: Markdown import needs a resolvable repository path: ${imported}`,
          );
        }
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
    const code = maskSourceNonCode(source);
    const temporaryFactories = temporaryPathFactories(code);
    const reads = importsFs ? filesystemReadBindings(source, code) : READ_CALLS;
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
        let resolved: GlobPathResult = pathExpression({
          expression: argument,
          code,
          source,
          file,
          temporaryFactories,
        });
        if (isGlob && resolved.kind === "repository") {
          resolved = globPath({
            expression: argument,
            target: resolved.value,
            call,
            start,
            source,
            code,
            file,
            temporaryFactories,
          });
        }
        if (resolved.kind === "declared") {
          for (const input of resolved.inputs) {
            inputs.add(input);
          }
          unresolvedInputs.add(argument);
          return;
        }
        if (
          isDirectory &&
          resolved.kind === "unresolved" &&
          resolved.prefix !== undefined
        ) {
          inputs.add(`${resolved.prefix}/**`);
          unresolvedInputs.add(argument);
          return;
        }
        const target =
          resolved.kind === "repository" ? resolved.value : undefined;
        if (
          target !== undefined &&
          !target.includes("\n") &&
          (MARKDOWN.test(target) || isDirectory)
        ) {
          inputs.add(
            isDirectory && !target.includes("*")
              ? `${target}/**`
              : target.replace(/^(?:\.\.\/)+/u, ""),
          );
        } else if (
          resolved.kind === "unresolved" &&
          expressionReferences({
            expression: argument,
            code,
            source,
            root,
            file,
            matchesExpression: (value) =>
              readStringLiterals(value).some((literal) =>
                MARKDOWN.test(literal.value),
              ),
          })
        ) {
          const declared = unresolvedReadInputs({
            expression: argument,
            code,
            source,
            file,
            temporaryFactories,
            policyReaders,
          });
          for (const input of declared) {
            inputs.add(input);
          }
          if (declared.length > 0) {
            unresolvedInputs.add(argument);
          }
        }
      }
      for (const input of gitMarkdownInputs(callee, call)) {
        inputs.add(input);
      }
    });
    if (inputs.size > 0) {
      const command = readerCommand(root, file);
      const reader = { file, inputs: [...inputs] };
      if (unresolvedInputs.size > 0) {
        readers.push({ ...reader, kind: "unresolved" });
      } else if (moduleInput || /^(?:apps|packages)\//u.test(file)) {
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
  if (root === ROOT) {
    rootReaders = readers;
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
      if (READER_PACKAGE_CHECKS[reader.kind]) {
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
