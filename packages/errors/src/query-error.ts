import { Result } from "better-result";

// Query failures are output through several runtimes, including SDK loggers.
// Project them before serialization; inspecting an Error exposes non-enumerable
// fields and its cause, so removing only `params` is insufficient.
const QUERY_ERROR_NAME = /^DrizzleQueryError\d*$/u;
const SQLSTATE = /^(?=.*[0-9])[0-9A-Z]{5}$/u;
const MAX_ERROR_DEPTH = 32;
const MAX_ERROR_NODES = 1000;
const IDENTIFIER = /^[a-zA-Z_][\w.$-]{0,127}$/u;
const SQL_KEYWORDS = new Set(
  "select insert into update delete from where values set returning on conflict do nothing default and or not null join left right inner outer as limit offset order by group having asc desc create alter table index constraint unique primary key references drop if exists begin commit rollback with union all count distinct in is case when then else end true false".split(
    " ",
  ),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isQueryError = (value: Record<string, unknown>): boolean =>
  (typeof value.name === "string" && QUERY_ERROR_NAME.test(value.name)) ||
  (typeof value.query === "string" && Array.isArray(value.params)) ||
  value.name === "PostgresError" ||
  (typeof value.code === "string" && SQLSTATE.test(value.code)) ||
  (typeof value.errno === "string" && SQLSTATE.test(value.errno));

/** Only vocabulary and placeholders survive; literals and identifiers do not. */
const queryShape = (query: string): string => {
  const tokens =
    query.match(
      /--[^\n]*|\/\*[\s\S]*?\*\/|(?:[eE])?'(?:[^'\\]|\\[\s\S]|'')*'|"(?:[^"]|"")*"|\$(?:[a-zA-Z_]\w*)?\$[\s\S]*?\$(?:[a-zA-Z_]\w*)?\$|\$\d+|[a-zA-Z_]\w*|\d+(?:\.\d+)?|[(),=<>.*;+/-]|\S/gu,
    ) ?? [];
  if (tokens.some((token) => token === "'" || token === '"')) {
    return "[query redacted]";
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

const containsQueryError = (value: unknown): boolean => {
  const visited = new WeakSet<object>();
  const pending = [value];
  for (
    let count = 0;
    pending.length > 0 && count < MAX_ERROR_NODES;
    count += 1
  ) {
    const item = pending.pop();
    if (!isRecord(item) || visited.has(item)) {
      continue;
    }
    visited.add(item);
    if (isQueryError(item)) {
      return true;
    }
    for (const key of Object.getOwnPropertyNames(item)) {
      pending.push(item[key]);
    }
    pending.push(item.cause);
  }
  // A graph too large to inspect is also too large to safely print.
  return pending.length > 0;
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
        ? SQLSTATE.test(field)
        : IDENTIFIER.test(field))
    ) {
      fields.push([key, field]);
    }
  }
  return Object.fromEntries(fields);
};

/**
 * Keep the original error in process for retries and classification. Output
 * receives a plain Error projection, without custom inspectors or serializers.
 * Database causes retain only SQLSTATE and schema identifiers, never detail,
 * hint, routine messages, parameters, or source SQL.
 */
export const sanitizeErrorForOutput = (value: unknown): unknown => {
  const seen = new WeakSet<object>();
  type VisitErrorOptions = {
    input: unknown;
    databaseCause?: boolean;
    depth?: number;
  };
  const visit = ({
    input,
    databaseCause = false,
    depth = 0,
  }: VisitErrorOptions): unknown => {
    if (!isRecord(input)) {
      if (databaseCause) {
        return "[redacted]";
      }
      return typeof input === "string" ? sanitizeQueryErrorText(input) : input;
    }
    if (depth > MAX_ERROR_DEPTH) {
      return "[truncated]";
    }
    if (seen.has(input)) {
      return "[circular]";
    }
    seen.add(input);
    const database = databaseCause || isQueryError(input);
    const cause =
      input.cause === undefined
        ? undefined
        : visit({
            input: input.cause,
            databaseCause: database,
            depth: depth + 1,
          });
    const causeChanged = cause !== input.cause;
    if (input instanceof Error || database) {
      if (
        !database &&
        !causeChanged &&
        !containsQueryError(input) &&
        (typeof input.message !== "string" ||
          sanitizeQueryErrorText(input.message) === input.message)
      ) {
        return input;
      }
      const output = new Error(
        database
          ? "Database query failed (values redacted)"
          : "Error caused by database query failure",
      );
      output.name =
        typeof input.name === "string" && IDENTIFIER.test(input.name)
          ? input.name
          : "Error";
      if (cause !== undefined) {
        output.cause = cause;
      }
      for (const [key, field] of Object.entries(
        queryErrorMetadata(input, cause),
      )) {
        Reflect.set(output, key, field);
      }
      if (typeof input.query === "string") {
        Reflect.set(output, "query", queryShape(input.query));
        output.message += `: ${queryShape(input.query)}`;
      }
      // Keep source locations, excluding headers and inferred function names.
      if (typeof input.stack === "string") {
        const frames = input.stack.split("\n").flatMap((line) => {
          const location = /^\s+at (?:.*?\()?([^()]+:\d+:\d+)\)?$/u
            .exec(line)
            ?.at(1);
          return location === undefined ? [] : [`    at ${location}`];
        });
        output.stack = `${output.name}: ${output.message}\n${frames.join("\n")}`;
      }
      return output;
    }
    if (Array.isArray(input)) {
      return input.map((item) => visit({ input: item, depth: depth + 1 }));
    }
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [
        key,
        visit({ input: item, depth: depth + 1 }),
      ]),
    );
  };
  return Result.try(() => visit({ input: value })).unwrapOr(
    "[unreadable error]",
  );
};

type ErrorOutputOptions = {
  level: "debug" | "info" | "warn" | "error";
  values: readonly unknown[];
};

/** Preserve SDK log levels while projecting every value before inspection. */
export const logErrorOutput = ({ level, values }: ErrorOutputOptions): void => {
  const method = level === "info" ? "log" : level;
  // oxlint-disable-next-line no-console -- sanitized console output boundary
  console[method](...values.map((value) => sanitizeErrorForOutput(value)));
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

/** Backstop for Drizzle messages flattened before reaching a structured sink. */
export const sanitizeQueryErrorText = (text: string): string =>
  text.replace(
    /Failed query:[\s\S]*$/iu,
    "Database query failed (values redacted)",
  );

/** Catch a script entrypoint before the runtime prints a raw rejection. */
export const runScriptWithErrorOutput = async (
  run: () => Promise<void>,
): Promise<void> => {
  const result = await Result.tryPromise(run);
  if (result.isErr()) {
    printError(result.error);
    process.exit(1);
  }
};
