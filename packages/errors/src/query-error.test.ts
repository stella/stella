import { Result } from "better-result";
import { afterEach, expect, test } from "bun:test";
import { inspect } from "node:util";

import {
  sanitizeErrorForOutput,
  sanitizeErrorAttributesForOutput,
  errorOutputLogger,
  sanitizeQueryErrorText,
} from "./query-error";
import { QUERY_ERROR_OUTPUT_FIELDS } from "./query-field-policy";
import { runScriptWithErrorOutput } from "./script-error";

const SECRET = "fixture-private-query-value-92ab";
const failure = (query: string) =>
  Object.assign(new Error(`Failed query: ${query}\nparams: ${SECRET}`), {
    name: "DrizzleQueryError",
    query,
    params: [SECRET],
    cause: Object.assign(new Error(`Key (token)=(${SECRET}) already exists`), {
      name: "PostgresError",
      code: "23505",
      constraint_name: "account_token_unique",
      detail: SECRET,
    }),
  });

for (const literal of [
  `'${SECRET}'`,
  `E'${SECRET}\\'suffix'`,
  `$$${SECRET}$$`,
  `$label$${SECRET}$label$`,
  `42 /* ${SECRET} */`,
  `42 -- ${SECRET}\n`,
  `"${SECRET}"`,
  `'${SECRET}`,
]) {
  test(`query output removes values from SQL literal form ${literal.slice(0, 2)}`, () => {
    const error = failure(`insert into account values (${literal})`);
    expect(inspect(error)).toContain(SECRET);
    const safe = sanitizeErrorForOutput(error);
    const output = inspect(safe, { depth: 20 });
    expect(inspect(sanitizeErrorForOutput(safe), { depth: 20 })).toBe(output);
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("params:");
    expect(output).toContain("23505");
    expect(output).toContain("account_token_unique");
    expect(JSON.stringify(safe)).not.toContain(SECRET);
    expect(error.params).toEqual([SECRET]);
  });
}

test("stored query error text keeps no parameter values", () => {
  const stored = failure("insert into account values ($1)").message;
  expect(stored).toContain(SECRET);
  expect(sanitizeQueryErrorText(stored)).not.toContain(SECRET);
});

test("query output excludes multiline parameter values", () => {
  const parameter = "fixture-first-value\nfixture-second-value";
  const query = failure("insert into account values ($1)");
  query.params.push(parameter);
  query.message += `\n${parameter}`;
  const wrapper = new Error(`Wrapped query failure: ${parameter}`, {
    cause: query,
  });
  for (const input of [query, wrapper]) {
    const output = inspect(sanitizeErrorForOutput(input), { depth: 20 });
    expect(output).not.toContain("fixture-first-value");
    expect(output).not.toContain("fixture-second-value");
    expect(output).toContain("account_token_unique");
  }
});

test("query output redacts nested aggregate and cyclic causes without invoking custom inspectors", () => {
  const query = failure("insert into account values ($1)");
  Reflect.set(query, Symbol.for("nodejs.util.inspect.custom"), () => SECRET);
  Reflect.set(query, "toJSON", () => SECRET);
  const aggregate = new AggregateError([query], `Wrapped ${query.message}`);
  const cyclic = new Error("wrapper", { cause: query });
  Reflect.set(query.cause, "cause", cyclic);
  for (const input of [aggregate, cyclic, { error: query }]) {
    expect(inspect(sanitizeErrorForOutput(input), { depth: 20 })).not.toContain(
      SECRET,
    );
  }
});

test("query wrappers use a generic output name for parameter values", () => {
  const query = failure("insert into account values ($1)");
  const wrapper = new Error("Operation failed", { cause: query });
  wrapper.name = SECRET;
  const safe = sanitizeErrorForOutput(wrapper);
  expect(safe).toBeInstanceOf(Error);
  if (!(safe instanceof Error)) {
    throw new TypeError("Expected an error output projection");
  }
  expect(safe.name).toBe("Error");
  const output = inspect(safe, { depth: 20 });
  expect(output).not.toContain(SECRET);
  expect(JSON.stringify(safe)).not.toContain(SECRET);
  expect(output).toContain("23505");
  expect(output).toContain("account_token_unique");
  expect(wrapper.name).toBe(SECRET);
  expect(query.params).toEqual([SECRET]);
});

test("aggregate query output retains structured member diagnostics", () => {
  const query = `insert into account values ('${SECRET}')`;
  const first = failure(query);
  const second = failure(query);
  second.cause.code = "23514";
  second.cause.constraint_name = "account_status_check";
  const nested = new AggregateError([second], "Batch operation failed");
  const aggregate = new AggregateError(
    [first, nested],
    "Batch operation failed",
  );
  const safe = sanitizeErrorForOutput(aggregate);
  expect(safe).toBeInstanceOf(AggregateError);
  if (!(safe instanceof AggregateError)) {
    throw new TypeError("Expected an aggregate output projection");
  }
  expect(safe.errors).toEqual([
    expect.objectContaining({
      code: "23505",
      constraint_name: "account_token_unique",
      cause: expect.objectContaining({ code: "23505" }),
    }),
    expect.objectContaining({
      errors: [
        expect.objectContaining({
          code: "23514",
          constraint_name: "account_status_check",
          cause: expect.objectContaining({ code: "23514" }),
        }),
      ],
    }),
  ]);
  const output = inspect(safe, { depth: 20 });
  expect(output).not.toContain(SECRET);
  expect(output).not.toContain(query);
  expect(output).not.toContain("params");
  expect(output).toContain("insert into");
  expect(inspect(sanitizeErrorForOutput(safe), { depth: 20 })).toBe(output);
  expect(aggregate.errors).toEqual([first, nested]);
  expect(first.params).toEqual([SECRET]);
});

test("query output fails closed when a database error property cannot be read", () => {
  const error = failure("select $1");
  Object.defineProperty(error, "query", {
    get: () => {
      throw new TypeError(SECRET);
    },
  });
  expect(sanitizeErrorForOutput(error)).toBe("[unreadable error]");
});

const originalConsoleError = console.error;
const originalExit = process.exit;
afterEach(() => {
  console.error = originalConsoleError;
  process.exit = originalExit;
});

test("script boundary prints sanitized query rejections and reports a failing exit code", async () => {
  const records: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    records.push(args);
  };
  process.exit = (code) => {
    expect(code).toBe(1);
    throw new RangeError("script boundary exited");
  };
  const result = await Result.tryPromise(
    async () =>
      await runScriptWithErrorOutput(async () => {
        throw failure("insert into account values ($1)");
      }),
  );
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.cause).toBeInstanceOf(RangeError);
  }
  expect(records).toHaveLength(1);
  expect(inspect(records, { depth: 20 })).not.toContain(SECRET);
  expect(inspect(records, { depth: 20 })).toContain("account_token_unique");
});

test("SDK error output preserves log levels and redacts query values at every console sink", () => {
  const methods = ["debug", "log", "warn", "error"] as const;
  const originals = {
    debug: console.debug,
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  const records: { method: string; args: unknown[] }[] = [];
  const fields = Object.fromEntries(
    QUERY_ERROR_OUTPUT_FIELDS.map((key) => [key, SECRET]),
  );
  try {
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        records.push({ method, args });
      };
    }
    for (const level of ["debug", "info", "warn", "error"] as const) {
      errorOutputLogger.log(
        level,
        "query.failed",
        failure("insert into account values ($1)"),
        { requestId: "fixture-request", nested: fields, ...fields },
      );
    }
    expect(records.map(({ method }) => method)).toEqual([...methods]);
    expect(inspect(records, { depth: 20 })).not.toContain(SECRET);
    expect(inspect(records, { depth: 20 })).toContain("account_token_unique");
  } finally {
    for (const method of methods) {
      console[method] = originals[method];
    }
  }
});

test("query output preserves structural PostgreSQL driver codes", () => {
  const error = Object.assign(new Error(SECRET), {
    name: "PostgresError",
    code: "ERR_POSTGRES_CONNECTION_REFUSED",
    params: [SECRET],
  });
  const output = inspect(sanitizeErrorForOutput(error));
  expect(output).toContain("ERR_POSTGRES_CONNECTION_REFUSED");
  expect(output).not.toContain(SECRET);
});

test("query output drops every shared policy field from nested output records", () => {
  const keys = QUERY_ERROR_OUTPUT_FIELDS.flatMap((field) => [
    field,
    field.toUpperCase(),
    field.split("").join("_"),
    `database.${field.split("").join("-").toUpperCase()}`,
  ]);
  const fields = Object.fromEntries(keys.map((key) => [key, SECRET]));
  const payload = { requestId: "fixture-request", ...fields, nested: fields };
  expect(sanitizeErrorForOutput(payload)).toEqual({
    requestId: "fixture-request",
    nested: {},
  });
  const error = Object.assign(new Error("fixture error"), fields);
  expect(inspect(sanitizeErrorForOutput(error))).not.toContain(SECRET);
});

test("query output projects ordinary errors with query text in their stack", () => {
  const error = new Error("Database operation failed");
  error.stack = `Error: Database operation failed\nFailed query: insert into account values ($1)\nparams: ${SECRET}`;
  const safe = sanitizeErrorForOutput(error);
  expect(inspect(safe)).not.toContain(SECRET);
  expect(safe).not.toBe(error);
  expect(error.message).toBe("Database operation failed");
  expect(error.stack).toContain(SECRET);
});

test("ordinary error stacks use the shared query field policy", () => {
  for (const field of QUERY_ERROR_OUTPUT_FIELDS) {
    const error = new Error("Database operation failed");
    error.stack = `Error: Database operation failed\n${field}: ${SECRET}`;
    const nested = Object.assign(new Error("Operation failed"), { error });
    for (const input of [
      error,
      nested,
      new Error("Operation failed", { cause: error }),
    ]) {
      expect(
        inspect(sanitizeErrorForOutput(input), { depth: 20 }),
      ).not.toContain(SECRET);
    }
  }
});

test("query output projects strings throughout one logged value", () => {
  const query = failure("insert into account values ($1)");
  const shapes = [
    SECRET,
    [SECRET, { note: SECRET }],
    { message: `Operation failed: ${SECRET}`, cause: query },
    { outer: { cause: { cause: query, note: SECRET }, note: SECRET } },
  ];
  for (const shape of shapes) {
    const input = [shape, query];
    expect(inspect(input, { depth: 20 })).toContain(SECRET);
    const projected = sanitizeErrorForOutput(input);
    const output = inspect(projected, { depth: 20 });
    expect(output).not.toContain(SECRET);
    expect(JSON.stringify(projected)).not.toContain(SECRET);
    expect(output).toContain("account_token_unique");
    expect(output).toContain("23505");
    expect(output).toContain("insert into ? values ( $1 )");
    expect(inspect(sanitizeErrorForOutput(projected), { depth: 20 })).toBe(
      output,
    );
  }
});

test.each([
  { parameter: 123_456, unrelated: [123_456n, true, 654_321] },
  { parameter: 123_456n, unrelated: [123_456, true, 654_321n] },
  { parameter: true, unrelated: [1, 1n, false] },
  { parameter: false, unrelated: [0, 0n, true] },
])(
  "query output projects $parameter by value and type throughout one logged value",
  ({ parameter, unrelated }) => {
    const query = Object.assign(new Error("Database query failed"), {
      name: "DrizzleQueryError",
      query: "insert into account values ($1)",
      params: [parameter],
    });
    const diagnostic = {
      diagnostic: parameter,
      nested: [parameter],
      unrelated,
    };
    const projected = sanitizeErrorForOutput([diagnostic, query]);
    expect(projected).toEqual([
      { diagnostic: "[redacted]", nested: ["[redacted]"], unrelated },
      expect.any(Error),
    ]);
    expect(sanitizeErrorForOutput(projected)).toEqual(projected);
    expect(sanitizeErrorForOutput(diagnostic)).toEqual(diagnostic);
    expect(query.params).toEqual([parameter]);
  },
);

test("string query parameters do not redact equal primitive representations", () => {
  const query = Object.assign(new Error("Database query failed"), {
    name: "DrizzleQueryError",
    query: "insert into account values ($1)",
    params: ["123456", "true", "false"],
  });
  const diagnostic = {
    number: 123_456,
    bigint: 123_456n,
    yes: true,
    no: false,
  };
  expect(sanitizeErrorForOutput([diagnostic, query])).toEqual([
    diagnostic,
    expect.any(Error),
  ]);
});

const DATE_PARAMETER = new Date("2026-04-05T06:07:08.009Z");

test.each([
  {
    name: "date",
    parameter: DATE_PARAMETER,
    representations: [DATE_PARAMETER.toISOString(), String(DATE_PARAMETER)],
  },
  {
    name: "Uint8Array",
    parameter: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    representations: ["222,173,190,239", "\\xdeadbeef"],
  },
  {
    name: "Buffer",
    parameter: Buffer.from("fixture-buffer-query-value"),
    representations: [
      "fixture-buffer-query-value",
      "\\x666978747572652d6275666665722d71756572792d76616c7565",
    ],
  },
])(
  "query output redacts $name parameter text representations",
  ({ parameter, representations }) => {
    // Shaped like the driver's query error, whose message prints each
    // parameter with String().
    const query = Object.assign(
      new Error(
        `Failed query: insert into account values ($1)\nparams: ${String(parameter)}`,
      ),
      {
        name: "DrizzleQueryError",
        query: "insert into account values ($1)",
        params: [parameter],
        cause: new Error("fixture driver failure"),
      },
    );
    const unrelated = {
      text: "unrelated diagnostic remains visible",
      numericByte: 0xde,
    };
    const projected = sanitizeErrorForOutput([
      ...representations,
      unrelated,
      query,
    ]);
    expect(projected).toEqual([
      ...representations.map(() => "[redacted]"),
      unrelated,
      expect.any(Error),
    ]);
    expect(sanitizeErrorForOutput([unrelated, query])).toEqual([
      unrelated,
      expect.any(Error),
    ]);
  },
);

test("binary query parameters are redacted when diagnostics carry their bytes", () => {
  const parameter = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const query = Object.assign(new Error("Database query failed"), {
    name: "DrizzleQueryError",
    query: "insert into account values ($1)",
    params: [parameter],
  });
  expect(
    sanitizeErrorForOutput([
      { same: parameter, copy: Buffer.from(parameter) },
      query,
    ]),
  ).toEqual([{ same: "[redacted]", copy: "[redacted]" }, expect.any(Error)]);
  const unrelated = new Uint8Array([0x01, 0x02]);
  expect(sanitizeErrorForOutput([{ unrelated }, query])).not.toEqual([
    { unrelated: "[redacted]" },
    expect.any(Error),
  ]);
});

test("query attribute output projects the whole record and keeps a record on failure", () => {
  const attrs = sanitizeErrorAttributesForOutput({
    message: SECRET,
    cause: failure("insert into account values ($1)"),
  });
  const output = inspect(attrs, { depth: 20 });
  expect(output).not.toContain(SECRET);
  expect(output).toContain("account_token_unique");
  expect(output).toContain("23505");
  expect(
    sanitizeErrorAttributesForOutput({
      get cause() {
        throw new Error("Fixture value unavailable");
      },
    }),
  ).toEqual({ diagnostic: "[unreadable error]" });
});
