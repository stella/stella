import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
/**
 * The schema index: every table and column as one grep-able line.
 *
 * "Is this stored, and where?" is the first question of most changes, and the
 * schema that answers it is 70-odd modules of Drizzle declarations. The index
 * puts each column on one line with its SQL name, its builder, its flags, its
 * declaration's `file:line` and the first sentence of its comment, so one
 * `rg <word> apps/api/src/db/schema-index` answers it without reading a
 * schema module.
 *
 * Read from the schema source, not the runtime tables: the comments and line
 * numbers only exist there, and reading text keeps this generator outside the
 * schema-introspection allowlist (`SCHEMA_INTROSPECTION` in
 * `scripts/ownership.ts`) — it never imports the schema. One index file per
 * schema module, so two pull requests changing different modules never
 * conflict in the index.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareCodeUnit } from "@stll/collation";
import { repoRelativePath } from "@stll/portable-path";
import {
  type CallExpression,
  type Expression,
  type Node,
  type ObjectExpression,
  type ParsedSource,
  parseSource,
  type PropertyKey,
  walk,
} from "@stll/scripts/src/syntax-tree";

import {
  formattedArtifactsLikeRepository,
  writeOrCheckArtifacts,
} from "../../../scripts/generated-artifacts";

const DB_DIR = fileURLToPath(new URL("../src/db/", import.meta.url));
const SCHEMA_DIR = path.join(DB_DIR, "schema");
const INDEX_DIR = path.join(DB_DIR, "schema-index");
const API_SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

/** Schema modules outside `schema/` that `schema.ts` and auth export. */
const EXTRA_SCHEMA_FILES = [
  "agent-auth-schema.ts",
  "auth-schema.ts",
  "registration-budget-schema.ts",
] as const;

/** Words whose closing full stop does not end a sentence. */
const ABBREVIATIONS = new Set([
  "approx.",
  "cf.",
  "e.g.",
  "etc.",
  "i.e.",
  "incl.",
  "resp.",
  "viz.",
  "vs.",
]);

const SENTENCE_STOPS = new Set([".", "!", "?"]);

/** A comment line without its `/**`, `*`, `*\/` or `//` decoration. */
const commentLineText = (line: string): string => {
  let text = line.trim();
  for (const prefix of ["/**", "/*", "//", "*"]) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  if (text.endsWith("*/")) {
    text = text.slice(0, -2);
  }
  return text.trim();
};

const OPENERS = new Set(["(", "[", '"', "'", "`", "“", "‘"]);

/** A word without the brackets and quotes that open it: `(e.g.` is `e.g.`. */
const withoutOpeners = (word: string): string => {
  let start = 0;
  while (start < word.length && OPENERS.has(word.charAt(start))) {
    start += 1;
  }
  return word.slice(start);
};

/**
 * The first sentence of flattened text: up to the first word that ends in a
 * stop, unless that word is a common abbreviation.
 */
const firstSentence = (text: string): string => {
  const words = text.split(" ");
  const end = words.findIndex(
    (word) =>
      SENTENCE_STOPS.has(word.at(-1) ?? "") &&
      !ABBREVIATIONS.has(withoutOpeners(word).toLowerCase()),
  );
  return end === -1 ? text : words.slice(0, end + 1).join(" ");
};

/** Longest summary kept per line; the comment itself is one jump away. */
const SUMMARY_MAX_LENGTH = 160;

const TABLE_BUILDERS = new Set(["pgTable", "withRLS"]);
/** Flags in one fixed order, so a line reads the same in every module. */
const FLAG_ORDER = [
  "pk",
  "fk",
  "unique",
  "array",
  "default",
  "generated",
  "not null",
  "null",
] as const;

export type IndexedColumn = {
  builder: string;
  flags: readonly string[];
  key: string;
  line: number;
  sqlName: string;
  summary: string;
};

export type IndexedTable = {
  columns: readonly IndexedColumn[];
  exportName: string;
  line: number;
  rls: boolean;
  sqlName: string;
  summary: string;
};

export const schemaSourceFiles = (): string[] =>
  [
    ...readdirSync(SCHEMA_DIR)
      .filter((file) => file.endsWith(".ts") && !file.includes(".test."))
      .map((file) => path.join(SCHEMA_DIR, file)),
    ...EXTRA_SCHEMA_FILES.map((file) => path.join(DB_DIR, file)),
  ].toSorted(compareCodeUnit);

/**
 * The first sentence of the comment directly above `node`, flattened to one
 * line; empty when there is none.
 */
const isLineBreak = (character: string | undefined) =>
  character === "\n" ||
  character === "\r" ||
  character === "\u2028" ||
  character === "\u2029";

/**
 * The comments that lead `node`: those after the line break that ends the
 * previous token's line, or every one at the start of the file.
 */
const leadingCommentRanges = (node: Node, parsed: ParsedSource) => {
  const { comments, sourceText } = parsed;
  const commentEndingAt = new Map(
    comments.map((comment) => [comment.end, comment]),
  );
  const commentStartingAt = new Map(
    comments.map((comment) => [comment.start, comment]),
  );
  // Back over the whitespace and comments between the previous token and
  // `node` to where the previous token ends.
  let position = node.start;
  for (;;) {
    while (position > 0 && /\s/u.test(sourceText.charAt(position - 1))) {
      position -= 1;
    }
    const comment = commentEndingAt.get(position);
    if (comment === undefined) {
      break;
    }
    position = comment.start;
  }
  const ranges: { start: number; end: number; multiLine: boolean }[] = [];
  let collecting = position === 0;
  while (position < node.start) {
    const character = sourceText.charAt(position);
    if (isLineBreak(character)) {
      collecting = true;
      position += 1;
      continue;
    }
    const comment = commentStartingAt.get(position);
    if (comment === undefined) {
      position += 1;
      continue;
    }
    if (collecting) {
      ranges.push({
        end: comment.end,
        multiLine: comment.type === "Block",
        start: comment.start,
      });
    }
    position = comment.end;
  }
  return ranges;
};

export const leadingSummary = (node: Node, parsed: ParsedSource): string => {
  const ranges = leadingCommentRanges(node, parsed);
  // A JSDoc block, or the run of line comments, nearest the declaration.
  const nearest = ranges.at(-1);
  if (nearest === undefined) {
    return "";
  }
  const block = nearest.multiLine
    ? [nearest]
    : ranges
        .slice(ranges.findLastIndex((range) => range.multiLine) + 1)
        .filter((range) => !range.multiLine);
  const text = block
    .map((range) => parsed.sourceText.slice(range.start, range.end))
    .join("\n")
    .split("\n")
    .map(commentLineText)
    .filter((line) => line !== "")
    .join(" ")
    .split(" ")
    .filter((word) => word !== "")
    .join(" ");
  const sentence = firstSentence(text);
  return sentence.length > SUMMARY_MAX_LENGTH
    ? `${sentence.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd()}…`
    : sentence;
};

/** A string literal's or substitution-free template's text. */
const stringText = (node: Node | undefined): string | undefined => {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};

const calleeName = (expression: Node): string | null => {
  if (expression.type === "Identifier") {
    return expression.name;
  }
  if (expression.type === "MemberExpression" && !expression.computed) {
    return expression.property.type === "PrivateIdentifier"
      ? `#${expression.property.name}`
      : expression.property.name;
  }
  return null;
};

/** The first node, in source order, `match` reads a value from. */
const findFirst = <T>(
  root: Node,
  match: (node: Node) => T | null,
): T | null => {
  let found: T | null = null;
  walk(root, (node) => {
    if (found !== null) {
      return "skip-children";
    }
    found = match(node);
    return found === null ? undefined : "skip-children";
  });
  return found;
};

/** The `pgTable(...)` call an exported initializer makes, if any. */
const findTableCall = (root: Node): CallExpression | null =>
  findFirst(root, (node) => {
    if (node.type === "CallExpression") {
      const name = calleeName(node.callee);
      if (name !== null && TABLE_BUILDERS.has(name)) {
        return node;
      }
    }
    return null;
  });

const findViewCall = (root: Node): CallExpression | null =>
  findFirst(root, (node) =>
    node.type === "CallExpression" && calleeName(node.callee) === "pgView"
      ? node
      : null,
  );

const findViewSource = (root: Node): string | null =>
  findFirst(root, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      calleeName(node.callee) === "from"
    ) {
      const source = node.arguments.at(0);
      if (source?.type === "Identifier") {
        return source.name;
      }
    }
    return null;
  });

/** `pgTable(...).enableRLS()`: RLS switched on by the declaration's own chain. */
const enablesRls = (node: Node): boolean =>
  node.type === "CallExpression" &&
  node.callee.type === "MemberExpression" &&
  !node.callee.computed &&
  (calleeName(node.callee) === "enableRLS" || enablesRls(node.callee.object));

/**
 * A column builder chain, innermost call first: `p.text("x").notNull()` is
 * the builder `text`, named `x`, flagged `not null`.
 */
const describeColumn = (
  key: string,
  initializer: Expression,
): Pick<IndexedColumn, "builder" | "flags" | "sqlName"> => {
  const flags = new Set<string>();
  let current: Node = initializer;
  let builder = "?";
  let sqlName = key;
  while (current.type === "CallExpression") {
    const callee: Expression = current.callee;
    const name = calleeName(callee) ?? "?";
    if (
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "CallExpression"
    ) {
      switch (name) {
        case "notNull":
          flags.add("not null");
          break;
        case "primaryKey":
          flags.add("pk");
          flags.add("not null");
          break;
        case "unique":
          flags.add("unique");
          break;
        case "references":
          flags.add("fk");
          break;
        case "array":
          flags.add("array");
          break;
        case "default":
        case "defaultNow":
        case "defaultRandom":
        case "$defaultFn":
          flags.add("default");
          break;
        case "generatedAlwaysAs":
          // A computed column can stay nullable.
          flags.add("generated");
          break;
        case "generatedAlwaysAsIdentity":
        case "generatedByDefaultAsIdentity":
          // An identity column is always populated.
          flags.add("generated");
          flags.add("not null");
          break;
        default:
          break;
      }
      current = callee.object;
      continue;
    }
    builder = name;
    sqlName = stringText(current.arguments.at(0)) ?? sqlName;
    break;
  }
  if (!flags.has("not null")) {
    flags.add("null");
  }
  return {
    builder,
    flags: FLAG_ORDER.filter((flag) => flags.has(flag)),
    sqlName,
  };
};

const propertyKey = (name: PropertyKey): string | null =>
  name.type === "Identifier" ? name.name : (stringText(name) ?? null);

type IndexSchemaSourceOptions = {
  fileName: string;
  source: string;
};

export const indexSchemaSource = ({
  fileName,
  source,
}: IndexSchemaSourceOptions): IndexedTable[] => {
  const parsed = parseSource(fileName, source);
  const lineOf = (node: Node) => parsed.locate(node.start).line;
  const textOf = (node: Node) => source.slice(node.start, node.end);
  const tables: IndexedTable[] = [];
  const declarations = parsed.program.body.flatMap((statement) => {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.declaration?.type !== "VariableDeclaration"
    ) {
      return [];
    }
    return statement.declaration.declarations.flatMap(({ id, init }) =>
      id.type === "Identifier" && init !== null
        ? [{ initializer: init, name: id.name, statement }]
        : [],
    );
  });
  const tableColumns = new Map<string, ObjectExpression>();
  for (const declaration of declarations) {
    const call = findTableCall(declaration.initializer);
    const columnsArgument = call?.arguments.at(1);
    if (columnsArgument?.type === "ObjectExpression") {
      tableColumns.set(declaration.name, columnsArgument);
    }
  }
  for (const declaration of declarations) {
    const tableCall = findTableCall(declaration.initializer);
    const viewCall = findViewCall(declaration.initializer);
    const call = tableCall ?? viewCall;
    const sqlName = stringText(call?.arguments.at(0));
    const ownColumnsArgument = tableCall?.arguments.at(1);
    const viewSource =
      viewCall === null ? null : findViewSource(declaration.initializer);
    const columnsArgument =
      ownColumnsArgument ??
      (viewSource === null ? undefined : tableColumns.get(viewSource));
    if (
      call === null ||
      sqlName === undefined ||
      columnsArgument?.type !== "ObjectExpression"
    ) {
      continue;
    }
    const columns: IndexedColumn[] = [];
    for (const property of columnsArgument.properties) {
      // Columns a helper spreads in are listed by the helper's name, so a
      // reader knows to follow it rather than finding the table short.
      if (property.type === "SpreadElement") {
        const helper = textOf(property.argument);
        columns.push({
          builder: "spread",
          flags: [],
          key: `{...${helper}}`,
          line: lineOf(property),
          sqlName: `{...${helper}}`,
          summary: leadingSummary(property, parsed),
        });
        continue;
      }
      // Only `key: value` entries; shorthand, methods and accessors are not
      // columns.
      if (property.kind !== "init" || property.method || property.shorthand) {
        continue;
      }
      const key = property.computed ? null : propertyKey(property.key);
      if (key === null) {
        continue;
      }
      columns.push({
        key,
        line: lineOf(property),
        summary: leadingSummary(property, parsed),
        ...describeColumn(key, property.value),
      });
    }
    const { statement } = declaration;
    tables.push({
      columns,
      exportName: declaration.name,
      line: lineOf(statement),
      rls:
        (tableCall !== null && calleeName(tableCall.callee) === "withRLS") ||
        enablesRls(declaration.initializer) ||
        (tableCall !== null &&
          /Policies\(\)|pgPolicy\(/u.test(textOf(tableCall))),
      sqlName,
      summary: leadingSummary(statement, parsed),
    });
  }
  return tables;
};

const pad = (value: string, width: number) => value.padEnd(width);

/** One schema module's index, or null when it declares no table. */
export const renderSchemaIndex = (
  relativeSource: string,
  tables: readonly IndexedTable[],
): string | null => {
  if (tables.length === 0) {
    return null;
  }
  const sourceName = path.basename(relativeSource);
  const sections = tables.map((table) => {
    const rows = table.columns.map((column) => ({
      left: `${table.sqlName}.${column.sqlName}`,
      type: column.builder,
      flags: column.flags.join(","),
      where: `${sourceName}:${String(column.line)}`,
      summary: column.summary,
    }));
    const leftWidth = Math.max(...rows.map((row) => row.left.length), 0);
    const typeWidth = Math.max(...rows.map((row) => row.type.length), 0);
    const flagsWidth = Math.max(...rows.map((row) => row.flags.length), 0);
    const whereWidth = Math.max(...rows.map((row) => row.where.length), 0);
    const lines = rows.map((row) =>
      [
        pad(row.left, leftWidth),
        pad(row.type, typeWidth),
        pad(row.flags, flagsWidth),
        row.summary === "" ? row.where : pad(row.where, whereWidth),
        row.summary,
      ]
        .filter((part) => part !== "")
        .join("  ")
        .trimEnd(),
    );
    const heading = [
      `## ${table.sqlName}`,
      `\`${table.exportName}\``,
      `${sourceName}:${String(table.line)}`,
      ...(table.rls ? ["rls"] : []),
    ].join(" · ");
    return [
      heading,
      "",
      ...(table.summary === "" ? [] : [table.summary, ""]),
      "```text",
      ...lines,
      "```",
    ].join("\n");
  });
  return [
    `# Schema index: ${relativeSource}`,
    "",
    "<!-- GENERATED by apps/api/scripts/generate-schema-index.ts. Do not edit. -->",
    "",
    "One line per column: `table.column  builder  flags  file:line  first sentence of its comment`.",
    "",
    ...sections.flatMap((section) => [section, ""]),
  ].join("\n");
};

export const schemaIndexArtifacts = () =>
  schemaSourceFiles().flatMap((file) => {
    const relativeSource = repoRelativePath(API_SRC_DIR, file);
    const contents = renderSchemaIndex(
      relativeSource,
      indexSchemaSource({
        fileName: file,
        source: readFileSync(file, "utf-8"),
      }),
    );
    return contents === null
      ? []
      : [
          {
            path: path.join(INDEX_DIR, `${path.basename(file, ".ts")}.md`),
            contents,
          },
        ];
  });

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const artifacts = await formattedArtifactsLikeRepository(
    schemaIndexArtifacts(),
  );
  // An index whose schema module was removed or emptied is stale too.
  const expected = new Set(artifacts.map((artifact) => artifact.path));
  mkdirSync(INDEX_DIR, { recursive: true });
  const stale = readdirSync(INDEX_DIR)
    .map((file) => path.join(INDEX_DIR, file))
    .filter((file) => !expected.has(file));
  if (write) {
    for (const file of stale) {
      rmSync(file);
    }
  } else {
    for (const file of stale) {
      console.error(`stale: ${repoRelativePath(API_SRC_DIR, file)}`);
    }
  }
  const exitCode = await writeOrCheckArtifacts(artifacts, {
    write,
    matched: "the Drizzle schema source",
  });
  process.exitCode = !write && stale.length > 0 ? 1 : exitCode;
}
