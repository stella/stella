import { afterEach, expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import { inspect } from "node:util";

import {
  createDevErrorLogger,
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
  "fixture-value-shaped-as-frame",
] as const;
const FRAME_PARAM = `prefix\n    at packages/${SECRETS[3]}.ts:1:1`;
const QUERY_PARAMS = [...SECRETS, FRAME_PARAM];
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
  expect(error.stack).toContain(FRAME_PARAM);
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
        params: SECRETS.join(","),
        query: error.query,
      });
    }
    logger.request({
      message: "request.failed",
      method: "POST",
      severity: "ERROR",
      statusCode: 500,
      durationMs: 1,
      errorFingerprint: errorFingerprint(error),
      errorType: error.message,
    });
    expect(output).toHaveLength(4);
    assertSafe(output);
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
