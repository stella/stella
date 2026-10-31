import { panic } from "better-result";

import {
  migrationStatementTokens,
  parseMigrationStatements,
  readMigrationRelation,
} from "./check-migration-safety";

type Statement = ReturnType<typeof parseMigrationStatements>[number];
type Token = ReturnType<typeof migrationStatementTokens>[number];

const functionTokens = (statement: Statement): Token[] =>
  [
    ...migrationStatementTokens(statement),
    ...[...statement.text.matchAll(/[[\]]/gu)].map((match) => ({
      kind: "punctuation" as const,
      value: match[0],
      index: match.index,
    })),
  ].toSorted((left, right) => left.index - right.index);

const INPUT_MODES = new Set(["in", "inout", "variadic"]);
const MULTIWORD_TYPE_CONTINUATIONS = new Set([
  "precision",
  "varying",
  "with",
  "without",
]);
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  integer: "int4",
  int: "int4",
  smallint: "int2",
  bigint: "int8",
  boolean: "bool",
  decimal: "numeric",
  real: "float4",
  "double precision": "float8",
  "character varying": "varchar",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamp",
  "time with time zone": "timetz",
  "time without time zone": "time",
};

const inputTypeWords = (tokens: Token[], end: number) => {
  let depth = 0;
  const words: string[] = [];
  for (const token of tokens) {
    if (token.index >= end) {
      break;
    }
    if (token.value === "(" || token.value === "[") {
      depth++;
      continue;
    }
    if (token.value === ")" || token.value === "]") {
      depth--;
      continue;
    }
    if (depth === 0) {
      words.push(
        token.kind === "identifier" && !/^[a-z_][a-z0-9_]*$/u.test(token.value)
          ? JSON.stringify(token.value)
          : token.value,
      );
    }
  }
  return words
    .map((word, index) =>
      word === "." || words.at(index - 1) === "." ? word : ` ${word}`,
    )
    .join("")
    .trimStart()
    .replace(/^pg_catalog\./u, "");
};

/** Function identity excludes parameter names, defaults, OUT parameters and typmods. */
const argumentType = (
  statement: Statement,
  tokens: Token[],
  end: number,
): string | null => {
  let argumentEnd = end;
  let input = tokens;
  if (input.at(0)?.kind === "word" && input.at(0)?.value === "out") {
    return null;
  }
  if (
    input.at(0)?.kind === "word" &&
    INPUT_MODES.has(input.at(0)?.value ?? "")
  ) {
    input = input.slice(1);
  }
  const defaultIndex = input.findIndex(
    ({ kind, value }) => kind === "word" && value === "default",
  );
  if (defaultIndex !== -1) {
    argumentEnd = input.at(defaultIndex)?.index ?? argumentEnd;
    input = input.slice(0, defaultIndex);
  }
  const first = input.at(0);
  const second = input.at(1);
  if (first === undefined) {
    return panic("Migration function argument has no type");
  }
  if (
    second !== undefined &&
    second.kind !== "punctuation" &&
    !MULTIWORD_TYPE_CONTINUATIONS.has(second.value)
  ) {
    input = input.slice(1);
  }
  const start =
    input.at(0)?.index ??
    panic("Migration function argument has no input type");
  // The statement scanner masks literals/comments; array brackets and '='
  // remain in its keyword view even though relation tokens omit them.
  const equals = statement.text.slice(start, argumentEnd).indexOf("=");
  const typeEnd = equals === -1 ? argumentEnd : start + equals;
  const type = inputTypeWords(input, typeEnd);
  const hasArray = statement.text.slice(start, typeEnd).includes("[");
  const quotedType = input.some(
    ({ kind, index }) => kind === "identifier" && index < typeEnd,
  );
  const identityType = quotedType ? type : (TYPE_ALIASES[type] ?? type);
  return `${identityType}${hasArray ? "[]" : ""}`;
};

const readSignature = (
  statement: Statement,
  tokens: Token[],
  start: number,
) => {
  const named = readMigrationRelation(tokens, start);
  if (named === undefined || tokens.at(named.next)?.value !== "(") {
    return panic("Cannot read migration function identity");
  }
  const types: string[] = [];
  let depth = 1;
  let group: Token[] = [];
  for (let index = named.next + 1; index < tokens.length; index++) {
    const token = tokens.at(index) ?? panic("Missing migration function token");
    if (token.value === "(" || token.value === "[") {
      depth++;
    }
    if (token.value === ")" || token.value === "]") {
      depth--;
    }
    if (depth === 0 || (depth === 1 && token.value === ",")) {
      if (group.length > 0) {
        const type = argumentType(statement, group, token.index);
        if (type !== null) {
          types.push(type);
        }
      }
      group = [];
      if (depth === 0) {
        return {
          key: JSON.stringify([
            named.relation.schema,
            named.relation.name,
            types,
          ]),
          schema: named.relation.schema,
          name: named.relation.name,
          types,
          next: index + 1,
        };
      }
    } else {
      group.push(token);
    }
  }
  return panic("Unterminated migration function signature");
};

const executableIdentifiers = (source: string): string =>
  parseMigrationStatements(source)
    .map((statement) =>
      migrationStatementTokens(statement)
        .filter(({ kind }) => kind !== "punctuation")
        .map(({ value }) => value)
        .join(" "),
    )
    .join("\n");

const functionBody = (
  statement: Statement,
  tokens: Token[],
  start: number,
): string => {
  const bodyStart = tokens
    .slice(start)
    .find(
      ({ kind, value }) =>
        kind === "word" && ["as", "return", "begin"].includes(value),
    );
  if (bodyStart === undefined) {
    return panic("Cannot read migration function body");
  }
  if (bodyStart.value !== "as") {
    return executableIdentifiers(statement.raw.slice(bodyStart.index));
  }
  const literal = statement.literals.find(
    ({ index }) => index > bodyStart.index,
  );
  if (literal === undefined) {
    return panic("Migration function AS has no body");
  }
  return executableIdentifiers(literal.value);
};

/** Fold migration order, retaining only bodies that remain installed. */
export const currentMigrationFunctionCorpus = (
  migrations: readonly string[],
): string => {
  const functions = new Map<string, string>();
  for (const source of migrations) {
    for (const statement of parseMigrationStatements(source)) {
      if (statement.deferred) {
        continue;
      }
      const tokens = functionTokens(statement);
      const words = tokens.map(({ value }) => value);
      const create = words.at(0) === "create";
      let cursor =
        create && words.at(1) === "or" && words.at(2) === "replace" ? 3 : 1;
      const operation = words.at(0);
      if (
        words.at(cursor) !== "function" ||
        (!create && operation !== "drop" && operation !== "alter")
      ) {
        continue;
      }
      cursor++;
      if (
        !create &&
        words.at(cursor) === "if" &&
        words.at(cursor + 1) === "exists"
      ) {
        cursor += 2;
      }
      do {
        const signature = readSignature(statement, tokens, cursor);
        if (create) {
          functions.set(
            signature.key,
            functionBody(statement, tokens, signature.next),
          );
        } else if (operation === "drop") {
          functions.delete(signature.key);
        } else if (
          words.at(signature.next) === "rename" &&
          words.at(signature.next + 1) === "to"
        ) {
          const body = functions.get(signature.key);
          const name =
            words.at(signature.next + 2) ??
            panic("Missing renamed function name");
          functions.delete(signature.key);
          if (body !== undefined) {
            functions.set(
              JSON.stringify([signature.schema, name, signature.types]),
              body,
            );
          }
        } else if (
          words.at(signature.next) === "set" &&
          words.at(signature.next + 1) === "schema"
        ) {
          const body = functions.get(signature.key);
          const schema =
            words.at(signature.next + 2) ?? panic("Missing function schema");
          functions.delete(signature.key);
          if (body !== undefined) {
            functions.set(
              JSON.stringify([schema, signature.name, signature.types]),
              body,
            );
          }
        }
        cursor = signature.next;
        if (create || words.at(cursor) !== ",") {
          break;
        }
        cursor++;
      } while (cursor < tokens.length);
    }
  }
  return [...functions.values()].join("\n");
};
