import { Result } from "better-result";
import { afterEach, expect, test } from "bun:test";
import { inspect } from "node:util";

import {
  sanitizeErrorForOutput,
  errorOutputLogger,
  runScriptWithErrorOutput,
} from "./query-error";

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
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("params:");
    expect(output).toContain("23505");
    expect(output).toContain("account_token_unique");
    expect(JSON.stringify(safe)).not.toContain(SECRET);
    expect(error.params).toEqual([SECRET]);
  });
}

test("query output excludes multiline values shaped like stack frames", () => {
  const marker = "fixture-value-shaped-as-frame";
  for (const frame of [
    `    at ${marker}:1:1`,
    `    at handler (packages/${marker}.ts:1:1)`,
  ]) {
    const parameter = `prefix\n${frame}`;
    const query = Object.assign(
      new Error(
        `Failed query: insert into account values ($1)\nparams: ${parameter}`,
      ),
      {
        name: "DrizzleQueryError",
        query: "insert into account values ($1)",
        params: [parameter],
        cause: Object.assign(new Error(`Query rejected: ${parameter}`), {
          name: "PostgresError",
          code: "23505",
          constraint_name: "account_token_unique",
        }),
      },
    );
    expect(query.stack).toContain(frame);
    expect(query.cause.stack).toContain(frame);
    const wrapper = new Error(`Wrapped query failure: ${parameter}`, {
      cause: query,
    });
    for (const error of [query, wrapper]) {
      const safe = sanitizeErrorForOutput(error);
      expect(inspect(safe, { depth: 20 })).not.toContain(marker);
      expect(JSON.stringify(safe)).not.toContain(marker);
      expect(inspect(safe, { depth: 20 })).toContain("account_token_unique");
    }
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
  const result = await Result.tryPromise(() =>
    runScriptWithErrorOutput(async () => {
      throw failure("insert into account values ($1)");
    }),
  );
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(String(result.error)).toContain("script boundary exited");
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
      );
    }
    expect(records.map(({ method }) => method)).toEqual(methods);
    expect(inspect(records, { depth: 20 })).not.toContain(SECRET);
    expect(inspect(records, { depth: 20 })).toContain("account_token_unique");
  } finally {
    for (const method of methods) {
      console[method] = originals[method];
    }
  }
});
