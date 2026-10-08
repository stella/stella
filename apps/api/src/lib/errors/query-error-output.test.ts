import { afterEach, expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { inspect } from "node:util";

import {
  createDevErrorLogger,
  errorOutputLogger,
  QUERY_ERROR_OUTPUT_FIELDS,
  printError,
  sanitizeErrorForOutput,
} from "@stll/errors";

import { captureError } from "@/api/lib/analytics/capture";
import {
  connectionErrorFields,
  errorFingerprint,
  unredactedErrorFields,
  serializeDevError,
} from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const SECRETS = [
  "$argon2id$v=19$m=65536$fixture-password-hash",
  "fixture-private-token-9f8a",
  "fixture-person@example.test",
  "fixture-multiline-value",
] as const;
const QUERY_FIELD_KEYS = QUERY_ERROR_OUTPUT_FIELDS.flatMap((key) => [
  key,
  key.toUpperCase(),
  key.split("").join("_"),
  `database.${key.split("").join("-").toUpperCase()}`,
]);
const QUERY_FIELDS = Object.fromEntries(
  QUERY_FIELD_KEYS.map((key, index) => [
    key,
    `fixture-query-field-value-${index}`,
  ]),
);
const MULTILINE_PARAM = `fixture-first-value\n${SECRETS[3]}`;
const QUERY_PARAMS = [...SECRETS, MULTILINE_PARAM];
const queryFailure = () => {
  const driver = Object.assign(
    new Error(`Key (token)=(${SECRETS.at(1)}) already exists`),
    {
      name: "PostgresError",
      code: "23505",
      constraint: "account_token_unique",
      detail: SECRETS.join(","),
      hint: SECRETS.join(","),
      query: `insert into account values ('${SECRETS.at(1)}')`,
      params: QUERY_PARAMS,
    },
  );
  return new DrizzleQueryError(
    `insert into "account" ("password", "token") values ($1, $2) returning '${SECRETS.at(2)}'`,
    QUERY_PARAMS,
    driver,
  );
};
const assertSafe = (output: unknown) => {
  const printed = inspect(output, { depth: 20 });
  for (const secret of SECRETS) {
    expect(printed).not.toContain(secret);
  }
  expect(printed).not.toContain("params:");
};
const originalError = console.error;
afterEach(() => {
  console.error = originalError;
});

test("query error output excludes parameter values across console, dev sink and script printer", () => {
  const error = queryFailure();
  expect(inspect(error)).toContain(SECRETS[0]);
  expect(error.stack).toContain(MULTILINE_PARAM);
  const consoleRecords: unknown[][] = [];
  const sinkRecords: unknown[] = [];
  console.error = (...args: unknown[]) => {
    consoleRecords.push(args);
  };
  const devLog = createDevErrorLogger({
    echoErrors: true,
    sink: (record) => {
      sinkRecords.push(record);
    },
  });
  for (const failure of [
    error,
    new Error(`Wrapped: ${error.message}`, { cause: error }),
  ]) {
    devLog(failure, { nested: error });
    printError("Script failed:", failure);
    assertSafe(sanitizeErrorForOutput(failure));
  }
  expect(consoleRecords).toHaveLength(4);
  expect(sinkRecords).toHaveLength(2);
  assertSafe(consoleRecords);
  assertSafe(sinkRecords);
  const jsonl = JSON.stringify(serializeDevError(error));
  assertSafe(jsonl);
  expect(jsonl).toContain("account_token_unique");
  expect(inspect(consoleRecords, { depth: 20 })).toContain(
    "account_token_unique",
  );
  expect(inspect(consoleRecords, { depth: 20 })).toContain(
    "insert into ? ( ? , ? ) values ( $1 , $2 ) returning ?",
  );
  expect(error.params).toEqual(QUERY_PARAMS);
  expect(error.cause).toHaveProperty("code", "23505");
});

test("query error output excludes parameter values through logger and captureError", () => {
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  const consoleRecords: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    consoleRecords.push(args);
  };
  try {
    const error = queryFailure();
    captureError(error, {
      params: SECRETS.join(","),
      query: error.query,
      toolName: "list_matters",
    });
    logger.error("query.failed", {
      ...errorFingerprint(error),
      ...unredactedErrorFields(error),
    });
    logger.warn("query.failed", connectionErrorFields(error));
    logger.error(error.message, { "error.msg": error.message });
    expect(analytics.exceptions()).toHaveLength(1);
    expect(inspect(analytics.events)).toContain("list_matters");
    expect(logs.records).toHaveLength(3);
    assertSafe(analytics.events);
    assertSafe(logs.records);
    assertSafe(consoleRecords);
    expect(inspect(logs.records)).toContain("23505");
    expect(inspect(logs.records)).toContain("account_token_unique");
  } finally {
    analytics.restore();
    logs.restore();
  }
});

test("query error output excludes parameter values from stdout and stderr logger sinks", () => {
  const stdout = process.stdout.write;
  const stderr = process.stderr.write;
  const output: string[] = [];
  const record = (chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  process.stdout.write = record;
  process.stderr.write = record;
  try {
    const error = queryFailure();
    for (const level of ["debug", "info", "warn", "error"] as const) {
      logger[level](error.message, {
        ...unredactedErrorFields(error),
        ...QUERY_FIELDS,
      });
    }
    logger.request({
      message: "request.failed",
      method: "POST",
      severity: "ERROR",
      statusCode: 500,
      durationMs: 1,
      errorFingerprint: { ...errorFingerprint(error), ...QUERY_FIELDS },
      errorType: error.message,
    });
    expect(output).toHaveLength(4);
    assertSafe(output);
    for (const value of Object.values(QUERY_FIELDS)) {
      expect(output.join("\n")).not.toContain(value);
    }
    expect(output.join("\n")).toContain("23505");
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
});

test("dev JSONL derives ordinary error names from their class", () => {
  const error = new Error("failure");
  error.name = SECRETS[0];
  expect(serializeDevError(error)).toHaveProperty("name", "Error");
});

test("every error output sink drops fields from the shared query policy", () => {
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  const consoleRecords: unknown[][] = [];
  const devRecords: unknown[] = [];
  console.error = (...args: unknown[]) => {
    consoleRecords.push(args);
  };
  const payload = { requestId: "fixture-request", ...QUERY_FIELDS };
  const error = queryFailure();
  try {
    const devLog = createDevErrorLogger({
      echoErrors: true,
      sink: (record) => {
        devRecords.push(record);
      },
    });
    devLog(error, { ...payload, nested: payload });
    printError(payload);
    captureError(error, payload);
    for (const level of ["debug", "info", "warn", "error"] as const) {
      logger[level]("query.failed", payload);
    }
    const jsonl = serializeDevError({ ...payload, nested: payload });
    expect(jsonl).toEqual({
      requestId: "fixture-request",
      nested: { requestId: "fixture-request" },
    });
    expect(analytics.exceptions()).toHaveLength(1);
    expect(logs.records).toHaveLength(4);
    expect(devRecords).toHaveLength(1);
    expect(consoleRecords).toHaveLength(3);
    for (const sink of [
      analytics.events,
      logs.records,
      devRecords,
      consoleRecords,
      jsonl,
    ]) {
      const output = inspect(sink, { depth: 20 });
      for (const value of Object.values(QUERY_FIELDS)) {
        expect(output).not.toContain(value);
      }
      expect(output).toContain("fixture-request");
    }
  } finally {
    analytics.restore();
    logs.restore();
  }
});

test("output sinks exclude query text present only in an ordinary error stack", () => {
  const marker = "fixture-stack-query-value";
  const error = new Error("Database operation failed");
  error.stack = `Error: Database operation failed\nFailed query: insert into account values ($1)\nparams: ${marker}`;
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  const consoleRecords: unknown[][] = [];
  const devRecords: unknown[] = [];
  console.error = (...args: unknown[]) => {
    consoleRecords.push(args);
  };
  try {
    const devLog = createDevErrorLogger({
      echoErrors: true,
      sink: (record) => {
        devRecords.push(record);
      },
    });
    devLog(error);
    printError(error);
    captureError(error);
    logger.error("query.failed", unredactedErrorFields(error));
    expect(analytics.exceptions()).toHaveLength(1);
    expect(logs.records).toHaveLength(1);
    expect(devRecords).toHaveLength(1);
    expect(consoleRecords).toHaveLength(3);
    for (const output of [
      consoleRecords,
      devRecords,
      logs.records,
      analytics.events,
      serializeDevError(error),
    ]) {
      expect(inspect(output, { depth: 20 })).not.toContain(marker);
    }
    expect(error.stack).toContain(marker);
  } finally {
    analytics.restore();
    logs.restore();
  }
});

test("output sinks redact query markers across sibling and nested payloads", () => {
  const marker = SECRETS[1];
  const cases = [
    {
      name: "string",
      payload: `Diagnostic ${marker}`,
      failure: () =>
        new Error(`Diagnostic ${marker}`, { cause: queryFailure() }),
    },
    {
      name: "array",
      payload: [queryFailure(), `Diagnostic ${marker}`],
      failure: () => new Error("array wrapper", { cause: queryFailure() }),
    },
    {
      name: "plain object wrapper",
      payload: { message: `Diagnostic ${marker}`, cause: queryFailure() },
      failure: () => new Error("object wrapper", { cause: queryFailure() }),
    },
    {
      name: "nested cause",
      payload: new Error(`Diagnostic ${marker}`, {
        cause: {
          failure: new Error("inner wrapper", { cause: queryFailure() }),
          diagnostic: `Diagnostic ${marker}`,
        },
      }),
      failure: () =>
        new Error(`Diagnostic ${marker}`, {
          cause: {
            failure: new Error("inner wrapper", { cause: queryFailure() }),
            diagnostic: `Diagnostic ${marker}`,
          },
        }),
    },
  ] as const;
  const analytics = installRecordingAnalytics();
  const logs = installRecordingLogger();
  const consoleRecords: unknown[][] = [];
  const devRecords: unknown[] = [];
  console.error = (...args: unknown[]) => {
    consoleRecords.push(args);
  };
  const devLog = createDevErrorLogger({
    echoErrors: true,
    sink: (record) => devRecords.push(record),
  });

  try {
    for (const scenario of cases) {
      const error = scenario.failure();
      printError("query diagnostic", scenario.payload, error);
      devLog(error, { diagnostic: scenario.payload });
      errorOutputLogger.log(
        "error",
        "query diagnostic",
        scenario.payload,
        error,
      );
      captureError(error, { diagnostic: marker });
      logger.error(`Diagnostic ${marker}`, {
        diagnostic: scenario.payload,
        failure: error,
      });
    }

    for (const output of [
      consoleRecords,
      devRecords,
      analytics.events,
      logs.records,
    ]) {
      const printed = inspect(output, { depth: 30 });
      expect(printed).not.toContain(marker);
      for (const secret of SECRETS) {
        expect(printed).not.toContain(secret);
      }
    }
    expect(inspect(consoleRecords, { depth: 30 })).toContain(
      "account_token_unique",
    );
    expect(inspect(devRecords, { depth: 30 })).toContain("23505");
    expect(inspect(logs.records, { depth: 30 })).toContain(
      "insert into ? ( ? , ? ) values ( $1 , $2 ) returning ?",
    );
  } finally {
    analytics.restore();
    logs.restore();
  }
});
