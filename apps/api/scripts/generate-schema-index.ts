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

import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { compareCodeUnit } from "@stll/collation";

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
export const leadingSummary = (node: ts.Node, source: string): string => {
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [];
  // A JSDoc block, or the run of line comments, nearest the declaration.
  const nearest = ranges.at(-1);
  if (nearest === undefined) {
    return "";
  }
  const block =
    nearest.kind === ts.SyntaxKind.MultiLineCommentTrivia
      ? [nearest]
      : ranges
          .slice(
            ranges.findLastIndex(
              (range) => range.kind === ts.SyntaxKind.MultiLineCommentTrivia,
            ) + 1,
          )
          .filter(
            (range) => range.kind === ts.SyntaxKind.SingleLineCommentTrivia,
          );
  const text = block
    .map((range) => source.slice(range.pos, range.end))
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

const calleeName = (expression: ts.Expression): string | null => {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return null;
};

/** The `pgTable(...)` call an exported initializer makes, if any. */
const findTableCall = (node: ts.Node): ts.CallExpression | null => {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node.expression);
    if (name !== null && TABLE_BUILDERS.has(name)) {
      return node;
    }
  }
  return ts.forEachChild(node, findTableCall) ?? null;
};

/** `pgTable(...).enableRLS()`: RLS switched on by the declaration's own chain. */
const enablesRls = (node: ts.Expression): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  (node.expression.name.text === "enableRLS" ||
    enablesRls(node.expression.expression));

/**
 * A column builder chain, innermost call first: `p.text("x").notNull()` is
 * the builder `text`, named `x`, flagged `not null`.
 */
const describeColumn = (
  key: string,
  initializer: ts.Expression,
): Pick<IndexedColumn, "builder" | "flags" | "sqlName"> => {
  const flags = new Set<string>();
  let current: ts.Expression = initializer;
  let builder = "?";
  let sqlName = key;
  while (ts.isCallExpression(current)) {
    const callee = current.expression;
    const name = calleeName(callee) ?? "?";
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isCallExpression(callee.expression)
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
      current = callee.expression;
      continue;
    }
    builder = name;
    const named = current.arguments.at(0);
    if (named !== undefined && ts.isStringLiteralLike(named)) {
      sqlName = named.text;
    }
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

const propertyKey = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;

type IndexSchemaSourceOptions = {
  fileName: string;
  source: string;
};

export const indexSchemaSource = ({
  fileName,
  source,
}: IndexSchemaSourceOptions): IndexedTable[] => {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const lineOf = (node: ts.Node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;
  const tables: IndexedTable[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
        continue;
      }
      const call = findTableCall(declaration.initializer);
      const [nameArgument, columnsArgument] = call?.arguments ?? [];
      if (
        call === null ||
        nameArgument === undefined ||
        !ts.isStringLiteralLike(nameArgument) ||
        columnsArgument === undefined ||
        !ts.isObjectLiteralExpression(columnsArgument)
      ) {
        continue;
      }
      const columns: IndexedColumn[] = [];
      for (const property of columnsArgument.properties) {
        // Columns a helper spreads in are listed by the helper's name, so a
        // reader knows to follow it rather than finding the table short.
        if (ts.isSpreadAssignment(property)) {
          const helper = property.expression.getText(sourceFile);
          columns.push({
            builder: "spread",
            flags: [],
            key: `{...${helper}}`,
            line: lineOf(property),
            sqlName: `{...${helper}}`,
            summary: leadingSummary(property, source),
          });
          continue;
        }
        if (!ts.isPropertyAssignment(property)) {
          continue;
        }
        const key = propertyKey(property.name);
        if (key === null) {
          continue;
        }
        columns.push({
          key,
          line: lineOf(property),
          summary: leadingSummary(property, source),
          ...describeColumn(key, property.initializer),
        });
      }
      tables.push({
        columns,
        exportName: declaration.name.text,
        line: lineOf(statement),
        rls:
          calleeName(call.expression) === "withRLS" ||
          enablesRls(declaration.initializer) ||
          /Policies\(\)|pgPolicy\(/u.test(call.getText(sourceFile)),
        sqlName: nameArgument.text,
        summary: leadingSummary(statement, source),
      });
    }
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
    const relativeSource = path.relative(API_SRC_DIR, file);
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
      console.error(`stale: ${path.relative(API_SRC_DIR, file)}`);
    }
  }
  const exitCode = await writeOrCheckArtifacts(artifacts, {
    write,
    matched: "the Drizzle schema source",
  });
  process.exitCode = !write && stale.length > 0 ? 1 : exitCode;
}
