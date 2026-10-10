// parser-output-unchanged: This change only redacts query parameters from error output and does not change parser output.
import { Result } from "better-result";

import { isQueryErrorOutputKey } from "./query-field-policy";

// Output projections retain SQL shape, SQLSTATE, and schema identifiers.
// Original errors remain available in process for classification and retries.
const QUERY_ERROR_NAME = /^DrizzleQueryError\d*$/u;
const POSTGRES_DRIVER_CODE = /^ERR_POSTGRES_[A-Z0-9_]{1,64}$/u;
const SQLSTATE = /^(?=.*[0-9])[0-9A-Z]{5}$/u;
const QUERY_TEXT_LABEL_CHARACTER = /[a-zA-Z0-9_. -]/u;
const SQL_REDACTED_SHAPE = "[query redacted]";
const MAX_ERROR_DEPTH = 32;
const MAX_ERROR_NODES = 1000;
const ERROR_OUTPUT_NAMES = [
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "DrizzleQueryError",
  "PostgresError",
] as const;
const IDENTIFIER = /^[a-zA-Z_][\w.$-]{0,127}$/u;
const SQL_KEYWORDS = new Set(
  "select insert into update delete from where values set returning on conflict do nothing default and or not null join left right inner outer as limit offset order by group having asc desc create alter table index constraint unique primary key references drop if exists begin commit rollback with union all count distinct in is case when then else end true false".split(
    " ",
  ),
);

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const recordQueryText = (queryValues: Set<string>, text: string): void => {
  if (text.length === 0) {
    return;
  }
  queryValues.add(text);
  for (const line of text.split(/\r?\n/u)) {
    if (line.length > 0) {
      queryValues.add(line);
    }
  }
  const encoded = JSON.stringify(text).slice(1, -1);
  if (encoded.length > 0) {
    queryValues.add(encoded);
  }
};

const hexOfBytes = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

type QueryObjectValues = {
  text: Set<string>;
  // Binary parameters are matched by byte content across diagnostics.
  binary: Set<string>;
};

const recordQueryObjectText = (
  { text: queryValues, binary }: QueryObjectValues,
  input: object,
): boolean => {
  if (input instanceof Date) {
    if (!Number.isNaN(input.getTime())) {
      recordQueryText(queryValues, input.toISOString());
      recordQueryText(queryValues, String(input));
    }
    return true;
  }
  if (input instanceof Uint8Array) {
    recordQueryText(queryValues, String(input));
    const hex = hexOfBytes(input);
    binary.add(hex);
    if (hex.length > 0) {
      recordQueryText(queryValues, `\\x${hex}`);
    }
    return true;
  }
  return false;
};

const isQueryError = (value: Record<string, unknown>): boolean =>
  (typeof value["name"] === "string" && QUERY_ERROR_NAME.test(value["name"])) ||
  (typeof value["query"] === "string" && isUnknownArray(value["params"])) ||
  value["name"] === "PostgresError" ||
  (typeof value["code"] === "string" && SQLSTATE.test(value["code"])) ||
  (typeof value["errno"] === "string" && SQLSTATE.test(value["errno"]));

const scanQuery = (query: string): string[] =>
  query.match(
    /--[^\n]*|\/\*[\s\S]*?\*\/|(?:[eE])?'(?:[^'\\]|\\[\s\S]|'')*'|"(?:[^"]|"")*"|\$(?:[a-zA-Z_]\w*)?\$[\s\S]*?\$(?:[a-zA-Z_]\w*)?\$|\$\d+|[a-zA-Z_]\w*|\d+(?:\.\d+)?|[(),=<>.*;+/-]|\S/gu,
  ) ?? [];

const recordQueryLiterals = (queryValues: Set<string>, query: string): void => {
  for (const token of scanQuery(query)) {
    let literal: string | undefined;
    if (/^[eE]?'/u.test(token)) {
      literal = token.replace(/^[eE]?'/u, "").replace(/'$/u, "");
      literal = literal.replace(/''/gu, "'").replace(/\\(['\\])/gu, "$1");
    } else if (token.startsWith('"')) {
      literal = token.slice(1).replace(/"$/u, "").replace(/""/gu, '"');
    } else {
      const delimiter = /^\$[a-zA-Z_]*\$/u.exec(token)?.at(0);
      if (delimiter !== undefined) {
        literal = token.slice(delimiter.length, -delimiter.length);
      } else if (token.startsWith("--")) {
        literal = token.slice(2).trim();
      } else if (token.startsWith("/*")) {
        literal = token.slice(2, -2).trim();
      }
    }
    if (literal !== undefined) {
      recordQueryText(queryValues, literal);
    }
  }
};

/** Only vocabulary and placeholders survive; literals and identifiers do not. */
const queryShape = (query: string): string => {
  if (query === SQL_REDACTED_SHAPE) {
    return SQL_REDACTED_SHAPE;
  }
  const tokens = scanQuery(query);
  if (tokens.some((token) => token === "'" || token === '"')) {
    return SQL_REDACTED_SHAPE;
  }
  return tokens
    .map((token) => {
      if (
        SQL_KEYWORDS.has(token.toLowerCase()) ||
        /^\$\d+$/u.test(token) ||
        /^[(),=<>.*;+/-]$/u.test(token)
      ) {
        return token;
      }
      return "?";
    })
    .join(" ");
};

const queryErrorMetadata = (input: Record<string, unknown>, cause: unknown) => {
  const fields: [string, string][] = [];
  for (const key of [
    "code",
    "errno",
    "constraint",
    "constraint_name",
    "schema",
    "schema_name",
    "table",
    "table_name",
    "column",
    "column_name",
  ]) {
    const field = input[key] ?? (isRecord(cause) ? cause[key] : undefined);
    if (
      typeof field === "string" &&
      (key === "code" || key === "errno"
        ? SQLSTATE.test(field) ||
          (key === "code" && POSTGRES_DRIVER_CODE.test(field))
        : IDENTIFIER.test(field))
    ) {
      fields.push([key, field]);
    }
  }
  return Object.fromEntries(fields);
};

type VisitErrorOptions = {
  input: unknown;
  databaseCause?: boolean;
  depth?: number;
};

type ProjectErrorOptions = {
  input: Record<string, unknown>;
  database: boolean;
  cause: unknown;
  causeRedacted: boolean;
  depth: number;
  redaction: { count: number };
  projectText: (text: string) => string;
  visit: (options: VisitErrorOptions) => unknown;
};

const projectError = ({
  input,
  database,
  cause,
  causeRedacted,
  depth,
  redaction,
  projectText,
  visit,
}: ProjectErrorOptions): unknown => {
  const beforeMembers = redaction.count;
  const aggregateErrors =
    input instanceof AggregateError
      ? input.errors.map((member: unknown) =>
          visit({ input: member, databaseCause: database, depth: depth + 1 }),
        )
      : undefined;
  const membersRedacted = redaction.count > beforeMembers;
  const beforeFields = redaction.count;
  for (const key of Reflect.ownKeys(input)) {
    if (input instanceof AggregateError && key === "errors") {
      continue;
    }
    if (typeof key === "string" && isQueryErrorOutputKey(key)) {
      redaction.count += 1;
      continue;
    }
    if (key !== "cause") {
      visit({ input: Reflect.get(input, key), depth: depth + 1 });
    }
  }
  projectText(input instanceof Error ? input.message : "");
  if (input instanceof Error && input.stack !== undefined) {
    projectText(input.stack);
  }
  const fieldsRedacted = redaction.count > beforeFields;
  if (!database && !causeRedacted && !membersRedacted && !fieldsRedacted) {
    return input;
  }
  const message = database
    ? "Database query failed (values redacted)"
    : "Error caused by database query failure";
  const output =
    input instanceof AggregateError
      ? new AggregateError(aggregateErrors ?? [], message)
      : new Error(message);
  output.name =
    ERROR_OUTPUT_NAMES.find((name) => name === input["name"]) ?? "Error";
  if (cause !== undefined) {
    output.cause = cause;
  }
  for (const [key, field] of Object.entries(queryErrorMetadata(input, cause))) {
    Reflect.set(output, key, projectText(field));
  }
  const sql = input["query"] ?? input["sqlShape"];
  if (typeof sql === "string") {
    const shape = queryShape(sql);
    Reflect.set(output, "sqlShape", shape);
    output.message += `: ${shape}`;
  }
  // Query projections omit stacks; telemetry owns frame diagnostics.
  delete output.stack;
  if (database) {
    redaction.count += 1;
  }
  return output;
};

/**
 * Keep the original error in process for retries and classification. Output
 * receives standard Error or AggregateError projections without custom serializers.
 * Database causes retain only SQLSTATE and schema identifiers, never detail,
 * hint, routine messages, parameters, or source SQL.
 */
export const sanitizeErrorForOutput = (value: unknown): unknown => {
  const seen = new WeakSet<object>();
  const queryValues = new Set<string>();
  const queryPrimitiveValues = new Set<number | bigint | boolean>();
  const queryBinaryValues = new Set<string>();
  const redaction = { count: 0 };
  const projectText = (text: string): string => {
    const output = sanitizeQueryErrorText(text);
    if (output !== text) {
      redaction.count += 1;
      return output;
    }
    for (const queryValue of queryValues) {
      if (text.includes(queryValue)) {
        redaction.count += 1;
        return "[redacted]";
      }
    }
    return text;
  };
  // Primitive and binary parameters are matched by value, wherever they sit.
  const isQueryParameterValue = (input: unknown): boolean =>
    ((typeof input === "number" ||
      typeof input === "bigint" ||
      typeof input === "boolean") &&
      queryPrimitiveValues.has(input)) ||
    (input instanceof Uint8Array && queryBinaryValues.has(hexOfBytes(input)));
  const visit = ({
    input,
    databaseCause = false,
    depth = 0,
  }: VisitErrorOptions): unknown => {
    if (isQueryParameterValue(input)) {
      redaction.count += 1;
      return "[redacted]";
    }
    if (!isRecord(input)) {
      if (databaseCause) {
        redaction.count += 1;
        return "[redacted]";
      }
      if (typeof input === "function" || typeof input === "symbol") {
        return "[unsupported]";
      }
      if (typeof input === "string") {
        return projectText(input);
      }
      return input;
    }
    if (depth > MAX_ERROR_DEPTH) {
      // Whatever lies below is unread, so the ancestors must be projected.
      redaction.count += 1;
      return "[truncated]";
    }
    if (seen.has(input)) {
      // A repeated reference is projected where it first appeared; its other
      // holders must not fall back to returning their raw selves.
      redaction.count += 1;
      return "[circular]";
    }
    seen.add(input);
    if (isUnknownArray(input)) {
      return input.map((item) =>
        visit({ input: item, databaseCause, depth: depth + 1 }),
      );
    }
    const database = databaseCause || isQueryError(input);
    const beforeCause = redaction.count;
    const cause =
      input["cause"] === undefined
        ? undefined
        : visit({
            input: input["cause"],
            databaseCause: database,
            depth: depth + 1,
          });
    const causeRedacted = redaction.count > beforeCause;
    if (input instanceof Error || database) {
      return projectError({
        input,
        database,
        cause,
        causeRedacted,
        depth,
        redaction,
        projectText,
        visit,
      });
    }
    const entries = Object.entries(input);
    const kept = entries.filter(([key]) => !isQueryErrorOutputKey(key));
    // Dropping a query field is a redaction: an error holding this record
    // must not fall back to returning its original, unprojected self.
    redaction.count += entries.length - kept.length;
    return Object.fromEntries(
      kept.map(([key, item]) => {
        const safeKey = projectText(key);
        if (key === "cause") {
          return [safeKey, cause];
        }
        return [safeKey, visit({ input: item, depth: depth + 1 })];
      }),
    );
  };
  return Result.try(() => {
    type ScanEntry = { input: unknown; source: "output" | "query" };
    const pending: ScanEntry[] = [{ input: value, source: "output" }];
    const visitedOutput = new WeakSet<object>();
    const visitedQuery = new WeakSet<object>();
    for (
      let count = 0;
      pending.length > 0 && count < MAX_ERROR_NODES;
      count += 1
    ) {
      const entry = pending.pop();
      if (entry === undefined) {
        break;
      }
      const { input, source } = entry;
      if (!isRecord(input)) {
        if (typeof input === "string") {
          if (source === "query") {
            recordQueryText(queryValues, input);
          }
        } else if (
          source === "query" &&
          (typeof input === "number" ||
            typeof input === "bigint" ||
            typeof input === "boolean")
        ) {
          queryPrimitiveValues.add(input);
          queryValues.add(String(input));
        }
        continue;
      }
      if (
        source === "query" &&
        recordQueryObjectText(
          { text: queryValues, binary: queryBinaryValues },
          input,
        )
      ) {
        continue;
      }
      const visited = source === "query" ? visitedQuery : visitedOutput;
      if (visited.has(input)) {
        continue;
      }
      visited.add(input);
      const queryError = isQueryError(input);
      for (const key of Reflect.ownKeys(input)) {
        if (isUnknownArray(input) && key === "length") {
          continue;
        }
        const queryField =
          typeof key === "string" && isQueryErrorOutputKey(key);
        if (
          queryError &&
          typeof key === "string" &&
          (key === "query" || key === "sql") &&
          typeof input[key] === "string"
        ) {
          recordQueryLiterals(queryValues, input[key]);
        }
        pending.push({
          input: Reflect.get(input, key),
          source:
            source === "query" ||
            queryField ||
            (queryError && typeof key === "symbol")
              ? "query"
              : "output",
        });
      }
    }
    if (pending.length > 0) {
      return "[truncated error]";
    }
    return visit({ input: value });
  }).unwrapOr("[unreadable error]");
};

/** Project a complete attribute record through the shared output boundary. */
export const sanitizeErrorAttributesForOutput = (
  attributes: Record<string, unknown>,
): Record<string, unknown> => {
  const projected = sanitizeErrorForOutput(attributes);
  return isRecord(projected) && !isUnknownArray(projected)
    ? projected
    : { diagnostic: projected };
};

type ErrorOutputOptions = {
  level: "debug" | "info" | "warn" | "error";
  values: readonly unknown[];
};

/** Preserve SDK log levels while projecting every value before inspection. */
export const logErrorOutput = ({ level, values }: ErrorOutputOptions): void => {
  const method = level === "info" ? "log" : level;
  const safeValues = sanitizeErrorForOutput(values);
  console[method](...(isUnknownArray(safeValues) ? safeValues : [safeValues]));
};

/** Logger contract used by SDKs that own their exception printing. */
export const errorOutputLogger = {
  log: (
    level: ErrorOutputOptions["level"],
    message: string,
    ...args: unknown[]
  ): void => logErrorOutput({ level, values: [message, ...args] }),
};

/** Shared script printer: sanitize while errors still have their structure. */
export const printError = (...values: unknown[]): void => {
  logErrorOutput({ level: "error", values });
};

/** Project query payload text at string output boundaries. */
export const sanitizeQueryErrorText = (text: string): string => {
  if (/Failed query:/iu.test(text)) {
    return "Database query failed (values redacted)";
  }
  for (const delimiter of text.matchAll(/[:=]/gu)) {
    let end = delimiter.index;
    while (end > 0 && /\s/u.test(text.charAt(end - 1))) {
      end -= 1;
    }
    const quote = text.charAt(end - 1);
    if (quote === '"' || quote === "'") {
      end -= 1;
    }
    let start = end;
    while (
      start > 0 &&
      QUERY_TEXT_LABEL_CHARACTER.test(text.charAt(start - 1))
    ) {
      start -= 1;
    }
    if (isQueryErrorOutputKey(text.slice(start, end))) {
      return "Database query failed (values redacted)";
    }
  }
  return text;
};
