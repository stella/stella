#!/usr/bin/env bun
// Route every `lucide-react` import in apps/* and packages/* through the one
// icon module, `@stll/ui/icons` (packages/ui/src/icons.ts).
//
// Rerunnable (after a rebase brings in a new direct import) and idempotent:
//   1. Each `import { … } from "lucide-react"` (or `export { … } from`) is
//      rewritten to the icon module: `@stll/ui/icons`, or a relative path
//      inside packages/ui, which may not import itself by name.
//   2. A bare or `Lucide`-prefixed name is imported under its `…Icon` spelling
//      and aliased back to the local name, so no call site changes.
//   3. A glyph with a semantic entry is imported under that entry's name and
//      every reference to the local binding is renamed to it
//      (`WandSparklesIcon` becomes `AiActionIcon`); strings, comments and
//      property names keep their text. A glyph shared by several entries needs a per-file
//      choice in SEMANTIC_REWRITES; an unlisted file stops the run.
//   4. The plain re-export list at the bottom of the icon module is
//      regenerated from every name imported from it.
//
// usage:
//   bun scripts/codemod-icons.ts           rewrite in place
//   bun scripts/codemod-icons.ts --check   exit 1 when a rewrite is pending

import { panic } from "better-result";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { repoRelativePath } from "@stll/portable-path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const ICON_MODULE = "packages/ui/src/icons.ts";
const ICON_SPECIFIER = "@stll/ui/icons";
const UI_SOURCE_ROOT = "packages/ui/src/";
const SOURCE_FILE = /\.(?:[cm]?ts|tsx)$/u;
const GENERATED_START = "// @generated-start";
const GENERATED_END = "// @generated-end";

type SemanticRewrite = {
  // The entry every file gets, or null when the glyph has several meanings
  // and each file must be listed.
  readonly default: string | null;
  readonly byFile?: Readonly<Record<string, string>>;
};

// Lucide glyph (without the `Icon` suffix) -> semantic entry in the module.
const SEMANTIC_REWRITES: Readonly<Record<string, SemanticRewrite>> = {
  WandSparkles: { default: "AiActionIcon" },
  MessageSquarePlus: { default: "NewChatIcon" },
  MessageSquareQuote: { default: "AddCommentIcon" },
  BookOpen: {
    default: null,
    byFile: {
      "apps/web/src/components/workspace-primary-nav.ts": "CaseLawIcon",
      "apps/web/src/routes/law/index.tsx": "CaseLawIcon",
      "apps/web/src/routes/tools/-components/public-tools-index.tsx":
        "CaseLawIcon",
    },
  },
};

const lucide: Readonly<Record<string, unknown>> = await import(
  Bun.resolveSync("lucide-react", path.join(REPO_ROOT, "packages/ui"))
);

const checkOnly = process.argv.includes("--check");
const failures: string[] = [];
const changed: string[] = [];

const listSourceFiles = (): string[] => {
  const result = Bun.spawnSync({
    cmd: [
      "git",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps",
      "packages",
    ],
    cwd: REPO_ROOT,
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    panic("listing the repository's files failed");
  }
  return [
    ...new Set(
      result.stdout
        .toString()
        .split("\0")
        .filter(
          (file) =>
            SOURCE_FILE.test(file) &&
            file !== ICON_MODULE &&
            existsSync(path.join(REPO_ROOT, file)),
        ),
    ),
  ];
};

const iconSpecifierFor = (file: string): string => {
  if (!file.startsWith(UI_SOURCE_ROOT)) {
    return ICON_SPECIFIER;
  }
  const relative = repoRelativePath(
    path.dirname(file),
    ICON_MODULE.replace(/\.ts$/u, ""),
  );
  return relative.startsWith(".") ? relative : `./${relative}`;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

type Specifier = {
  readonly typeOnly: boolean;
  readonly imported: string;
  readonly local: string;
};

const parseSpecifiers = (list: string): Specifier[] =>
  list
    .split(",")
    // Whitespace collapsed to single spaces first, so `as` splits on a plain
    // string rather than a backtracking pattern.
    .map((part) => part.replaceAll(/\s+/gu, " ").trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const typeOnly = part.startsWith("type ");
      const body = typeOnly ? part.slice("type ".length) : part;
      const [imported = "", alias] = body.split(" as ");
      return { typeOnly, imported, local: alias ?? imported };
    });

const printSpecifier = ({ typeOnly, imported, local }: Specifier): string =>
  `${typeOnly ? "type " : ""}${imported === local ? imported : `${imported} as ${local}`}`;

const uniqueSpecifiers = (specifiers: readonly Specifier[]): Specifier[] => [
  ...new Map(
    specifiers.map((specifier) => [printSpecifier(specifier), specifier]),
  ).values(),
];

// The glyph a lucide export draws, without its `Icon` suffix or `Lucide`
// prefix, or null for a non-glyph export (a type, `Icon`, `createLucideIcon`).
const glyphOf = (name: string): string | null => {
  const value = lucide[name];
  if (value === undefined) {
    return null;
  }
  let base = name;
  if (name.endsWith("Icon") && name !== "Icon") {
    base = name.slice(0, -"Icon".length);
  } else if (name.startsWith("Lucide") && name.length > "Lucide".length) {
    base = name.slice("Lucide".length);
  }
  return lucide[`${base}Icon`] === value ? base : null;
};

const semanticFor = (glyph: string, file: string): string | null => {
  const rewrite = SEMANTIC_REWRITES[glyph];
  if (rewrite === undefined) {
    return null;
  }
  const chosen = rewrite.byFile?.[file] ?? rewrite.default;
  if (chosen === null) {
    failures.push(
      `${file}: '${glyph}' has several meanings; add the file to SEMANTIC_REWRITES.${glyph}.byFile in scripts/codemod-icons.ts with the entry it means.`,
    );
    return `${glyph}Icon`;
  }
  return chosen;
};

// One value import per module: fold a second `import { … } from "<icons>"`
// (a file that already imported a semantic entry) into the first.
const mergeValueImports = (source: string, target: string): string => {
  const statement = new RegExp(
    `^import\\s*\\{(?<list>[^}]*)\\}\\s*from\\s*["']${escapeRegExp(target)}["'];?\\n?`,
    "gmu",
  );
  const matches = [...source.matchAll(statement)];
  if (matches.length < 2) {
    return source;
  }
  const merged = uniqueSpecifiers(
    matches.flatMap((match) => parseSpecifiers(match.groups?.["list"] ?? "")),
  );
  let first = true;
  return source.replace(statement, () => {
    if (!first) {
      return "";
    }
    first = false;
    return `import { ${merged.map(printSpecifier).join(", ")} } from "${target}";\n`;
  });
};

type Edit = {
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

// The edit that renames one identifier, or null when it is a name rather than
// a reference to the binding: a member (`x.Name`), an object key, a class or
// type member, a JSX attribute, or the exported side of an export specifier.
const identifierEdit = (
  node: ts.Identifier,
  sourceFile: ts.SourceFile,
  to: string,
): Edit | null => {
  const { parent } = node;
  const start = node.getStart(sourceFile);
  const end = node.getEnd();
  if (ts.isShorthandPropertyAssignment(parent)) {
    return { start, end, text: `${node.text}: ${to}` };
  }
  if (ts.isExportSpecifier(parent)) {
    if (parent.propertyName === undefined) {
      return { start, end, text: `${to} as ${node.text}` };
    }
    return parent.propertyName === node ? { start, end, text: to } : null;
  }
  const isName =
    ((ts.isPropertyAccessExpression(parent) ||
      ts.isQualifiedName(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isEnumMember(parent) ||
      ts.isBindingElement(parent)) &&
      "name" in parent &&
      parent.name === node) ||
    (ts.isBindingElement(parent) && parent.propertyName === node) ||
    ts.isJsxAttribute(parent) ||
    ts.isImportSpecifier(parent);
  return isName ? null : { start, end, text: to };
};

/**
 * Rename every reference to the given bindings and nothing else. Parsed, not
 * matched as text, so a string literal, a comment, a test id or an object key
 * that spells the same name keeps it.
 */
export const renameIdentifiers = (
  file: string,
  source: string,
  renames: ReadonlyMap<string, string>,
): string => {
  if (renames.size === 0) {
    return source;
  }
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const edits: Edit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const to = renames.get(node.text);
      const edit =
        to === undefined ? null : identifierEdit(node, sourceFile, to);
      if (edit !== null) {
        edits.push(edit);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  let output = source;
  for (const { start, end, text } of edits.toSorted(
    (a, b) => b.start - a.start,
  )) {
    output = output.slice(0, start) + text + output.slice(end);
  }
  return output;
};

const LUCIDE_STATEMENT =
  /^(?<keyword>import|export)(?<typeKeyword>\s+type)?\s*\{(?<list>[^}]*)\}\s*from\s*["']lucide-react["'];?/gmu;

const rewriteFile = (file: string, source: string): string => {
  const renames = new Map<string, string>();
  const target = iconSpecifierFor(file);
  // The replacer receives LUCIDE_STATEMENT's capture groups positionally:
  // the keyword, the optional ` type`, and the specifier list.
  const output = source.replace(
    LUCIDE_STATEMENT,
    (
      _statement: string,
      keyword: string,
      typeGroup: string | undefined,
      list: string,
    ) => {
      const typeKeyword = typeGroup === undefined ? "" : " type";
      const specifiers = parseSpecifiers(list).map(
        ({ typeOnly, imported, local }): Specifier => {
          const glyph =
            typeOnly || typeKeyword !== "" ? null : glyphOf(imported);
          if (glyph === null) {
            return { typeOnly, imported, local };
          }
          const semantic = semanticFor(glyph, file);
          if (semantic === null) {
            return { typeOnly, imported: `${glyph}Icon`, local };
          }
          if (keyword === "import" && local === imported) {
            renames.set(local, semantic);
            return { typeOnly, imported: semantic, local: semantic };
          }
          return { typeOnly, imported: semantic, local };
        },
      );
      return `${keyword}${typeKeyword} { ${uniqueSpecifiers(specifiers).map(printSpecifier).join(", ")} } from "${target}";`;
    },
  );
  return mergeValueImports(renameIdentifiers(file, output, renames), target);
};

const modulePath = path.join(REPO_ROOT, ICON_MODULE);
const moduleSource = readFileSync(modulePath, "utf-8");

// The semantic entries the module declares by hand, e.g.
// `export { BookOpenIcon as SkillIcon } from "lucide-react";`.
const semantic = new Set(
  Array.from(
    moduleSource.matchAll(
      /^export \{ \w+ as (?<name>\w+) \} from "lucide-react";$/gmu,
    ),
    (match) => match.groups?.["name"] ?? "",
  ),
);

// Every name a file imports from the icon module, semantic entries aside.
const ICON_IMPORT =
  /^(?:import|export)(?<typeKeyword>\s+type)?\s*\{(?<list>[^}]*)\}\s*from\s*["'](?<source>[^"']+)["']/gmu;

const collectImportedNames = (
  file: string,
  source: string,
  values: Set<string>,
  types: Set<string>,
): void => {
  const target = iconSpecifierFor(file);
  for (const match of source.matchAll(ICON_IMPORT)) {
    if (match.groups?.["source"] !== target) {
      continue;
    }
    const statementType = match.groups["typeKeyword"] !== undefined;
    for (const specifier of parseSpecifiers(match.groups["list"] ?? "")) {
      if (semantic.has(specifier.imported)) {
        continue;
      }
      const isType =
        statementType ||
        specifier.typeOnly ||
        lucide[specifier.imported] === undefined;
      (isType ? types : values).add(specifier.imported);
    }
  }
};

// Printed the way the formatter prints it, so a rerun after formatting is a
// no-op: one line when it fits, one name per line otherwise.
const PRINT_WIDTH = 80;

const renderExport = (keyword: string, names: readonly string[]): string[] => {
  const oneLine = `${keyword} { ${names.join(", ")} } from "lucide-react";`;
  if (oneLine.length <= PRINT_WIDTH) {
    return [oneLine];
  }
  return [
    `${keyword} {`,
    ...names.map((name) => `  ${name},`),
    '} from "lucide-react";',
  ];
};

const renderGeneratedBlock = (
  values: ReadonlySet<string>,
  types: ReadonlySet<string>,
): string => {
  const lines = [
    `${GENERATED_START} by scripts/codemod-icons.ts: edit by importing a lucide name and rerunning it`,
  ];
  if (types.size > 0) {
    lines.push(...renderExport("export type", [...types].toSorted()));
  }
  if (values.size > 0) {
    lines.push(...renderExport("export", [...values].toSorted()));
  }
  lines.push(GENERATED_END);
  return lines.join("\n");
};

const main = (): void => {
  const values = new Set<string>();
  const types = new Set<string>();
  // Written only once every file rewrote cleanly, so a failed run leaves the
  // tree untouched.
  const pendingWrites = new Map<string, string>();

  for (const file of listSourceFiles()) {
    const absolute = path.join(REPO_ROOT, file);
    const source = readFileSync(absolute, "utf-8");
    const rewritten = source.includes("lucide-react")
      ? rewriteFile(file, source)
      : source;
    if (rewritten !== source) {
      changed.push(file);
      pendingWrites.set(absolute, rewritten);
    }
    collectImportedNames(file, rewritten, values, types);
  }

  for (const name of values) {
    const glyph = glyphOf(name);
    if (glyph === null) {
      failures.push(
        `'${name}' is imported from the icon module but is not a lucide icon.`,
      );
    } else if (SEMANTIC_REWRITES[glyph] !== undefined) {
      failures.push(
        `'${name}' has a semantic entry; import the entry instead of the plain glyph.`,
      );
    }
  }

  const startIndex = moduleSource.indexOf(GENERATED_START);
  const endIndex = moduleSource.indexOf(GENERATED_END);
  if (startIndex === -1 || endIndex === -1) {
    failures.push(`${ICON_MODULE}: generated block markers are missing.`);
  } else {
    const nextModule =
      moduleSource.slice(0, startIndex) +
      renderGeneratedBlock(values, types) +
      moduleSource.slice(endIndex + GENERATED_END.length);
    if (nextModule !== moduleSource) {
      changed.push(ICON_MODULE);
      pendingWrites.set(modulePath, nextModule);
    }
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  if (!checkOnly) {
    for (const [file, content] of pendingWrites) {
      writeFileSync(file, content);
    }
  }
  if (checkOnly && changed.length > 0) {
    console.error(
      `Icon imports need rewriting in ${changed.length} file(s); run bun scripts/codemod-icons.ts:\n${changed.join("\n")}`,
    );
    process.exit(1);
  }
  console.log(
    checkOnly
      ? "Icon imports are routed through the icon module."
      : `Rewrote ${changed.length} file(s).`,
  );
};

if (import.meta.main) {
  main();
}
