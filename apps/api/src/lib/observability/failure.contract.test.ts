/**
 * The failure owner's contract.
 *
 * Expected outcomes are written out, never read back from the tables under
 * test: every row names the reason and the grade it must get. Each code set's
 * expectations are `satisfies Record<…>` over the production set, so a code
 * added there fails to compile here until someone writes down what it means.
 * Field compatibility is checked against a frozen copy of the helpers as they
 * shipped before this owner existed (`tests/helpers/legacy-error-fields.ts`),
 * not against a projection of the code under test.
 */

import { Panic, UnhandledException } from "better-result";
import { SQL } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";

import type { FailureGrade, FailureReason } from "@stll/errors";
import {
  classifyFailure,
  declareFailureClass,
  FetchBoundaryError,
} from "@stll/errors";

import {
  aiHandlerError,
  classifyAIBoundaryFailure,
  classifyAIError,
  providerStatusFields,
} from "@/api/lib/ai-error";
import { captureError } from "@/api/lib/analytics/capture";
import { elysiaFailureReason } from "@/api/lib/errors/elysia-error";
import { resolveHandlerError } from "@/api/lib/errors/handler-error-resolution";
import {
  AIGenerationCancelledError,
  ChatEmptyCompletionError,
  ChatLoopDetectedError,
  DatabaseRlsError,
  HandlerError,
  TimeoutError,
  WorkflowIntegrationError,
} from "@/api/lib/errors/tagged-errors";
import { errorFingerprint, errorSystemFields } from "@/api/lib/errors/utils";
import type {
  ExpectedReason,
  FailureExpectation,
  FailureRequestState,
  FailureRule,
  HANDLER_CLIENT_STATUS_REASON,
  NETWORK_ERROR_CODE_REASON,
  PG_DRIVER_CODE_REASON,
  PG_SQL_STATE_REASON,
  REDIS_ERROR_CODE_REASON,
} from "@/api/lib/observability/failure";
import {
  causeChainAttributes,
  errorFields,
  failureSink,
  gradeFailure,
} from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";
import {
  flushFailureObservations,
  resetFailureObservationsForTesting,
} from "@/api/lib/observability/failure-shadow";
import { logger } from "@/api/lib/observability/logger";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { initRequestContext } from "@/api/lib/observability/request-context";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { pgErrorFields } from "@/api/lib/pg-error";
import * as legacy from "@/api/tests/helpers/legacy-error-fields";
import {
  modelStepFailure,
  PROVIDER_FAILURE_CASES,
} from "@/api/tests/helpers/provider-failure-cases";
import {
  installRecordingAnalytics,
  installRecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";
import type {
  RecordingAnalytics,
  RecordingLogger,
} from "@/api/tests/helpers/recording-telemetry";

const SENTINEL = "PRIVILEGED-SENTINEL";

const SINK = failureSink({ event: "contract.sink", expected: [] });

// --- Shapes, as each boundary delivers them -----------------------------------

const bunPgError = (sqlState: string): Error =>
  new SQL.PostgresError(`${SENTINEL} server message`, {
    code: "ERR_POSTGRES_SERVER_ERROR",
    errno: sqlState,
    detail: `Key (email)=(${SENTINEL}) already exists.`,
    hint: SENTINEL,
    severity: "ERROR",
  });

const bunPgDriverError = (code: string): Error =>
  new SQL.PostgresError(`${SENTINEL} connection message`, {
    code,
    detail: "",
    hint: "",
    severity: "",
  });

// pg-protocol's `DatabaseError`, which PGlite ships minified: the SQLSTATE in
// `code`, the protocol message name "error", and the server's severity.
const pgProtocolError = (sqlState: string): Error => {
  const error = Object.assign(new Error(`${SENTINEL} server message`), {
    code: sqlState,
    severity: "ERROR",
    detail: SENTINEL,
  });
  error.name = "error";
  return error;
};

const drizzle = (cause: unknown): DrizzleQueryError =>
  new DrizzleQueryError(
    `select '${SENTINEL}'`,
    [SENTINEL],
    cause instanceof Error ? cause : undefined,
  );

const codedError = (code: string, extra: Record<string, unknown> = {}): Error =>
  Object.assign(new Error(`${SENTINEL} ${code}`), { code, ...extra });

// The stack Bun writes for code evaluated under a caller-chosen
// `//# sourceURL`: the path is whatever the caller named.
const evalFrameError = (): Error => {
  const error = new Error("x");
  error.stack = `Error: x\n    at <anonymous> (${SENTINEL}.js:1:16)\n    at eval (unknown)`;
  return error;
};

const awsException = (name: string, httpStatusCode: number): Error => {
  const error = Object.assign(new Error(SENTINEL), {
    $fault: "client",
    $metadata: { httpStatusCode },
  });
  error.name = name;
  return error;
};

type Boundary = "ai" | "none";

type GradingRow = {
  readonly name: string;
  readonly error: () => unknown;
  readonly boundary?: Boundary;
  readonly request?: FailureRequestState;
  readonly reason: FailureReason;
  readonly grade: FailureGrade;
  readonly rule?: FailureRule;
};

type Expected = readonly [FailureReason, FailureGrade];

// --- Written-out expectations per code set ------------------------------------

const SQL_STATE_EXPECTED = {
  "57P01": ["pg_connection_lifecycle", "transient"],
  "57P02": ["pg_connection_lifecycle", "transient"],
  "57P03": ["pg_connection_lifecycle", "transient"],
  "57P05": ["pg_connection_lifecycle", "transient"],
  "40001": ["pg_serialization_failure", "transient"],
  "40P01": ["pg_deadlock", "defect"],
  "55P03": ["pg_lock_unavailable", "defect"],
  "57014": ["pg_query_canceled", "defect"],
  "28P01": ["pg_auth_failed", "defect"],
  "28000": ["pg_auth_failed", "defect"],
} as const satisfies Record<keyof typeof PG_SQL_STATE_REASON, Expected>;

// SQLSTATEs no set grades: they stay defects whatever the shape.
const UNGRADED_SQL_STATES = [
  "23505",
  "23503",
  "42501",
  "25006",
  "54000",
  "42703",
] as const;

const PG_DRIVER_EXPECTED = {
  ERR_POSTGRES_CONNECTION_CLOSED: ["pg_connection_lifecycle", "transient"],
  ERR_POSTGRES_CONNECTION_FAILED: ["pg_connection_lifecycle", "transient"],
  ERR_POSTGRES_CONNECTION_TIMEOUT: ["pg_connection_lifecycle", "transient"],
  ERR_POSTGRES_IDLE_TIMEOUT: ["pg_connection_lifecycle", "transient"],
  ERR_POSTGRES_LIFETIME_TIMEOUT: ["pg_connection_lifecycle", "transient"],
} as const satisfies Record<keyof typeof PG_DRIVER_CODE_REASON, Expected>;

const REDIS_EXPECTED = {
  ERR_REDIS_CONNECTION_CLOSED: ["redis_connection", "transient"],
  ERR_REDIS_CONNECTION_TIMEOUT: ["redis_connection", "transient"],
  ERR_REDIS_INVALID_RESPONSE: ["redis_poll_blip", "transient"],
} as const satisfies Record<keyof typeof REDIS_ERROR_CODE_REASON, Expected>;

const NETWORK_EXPECTED = {
  ECONNRESET: ["network_reset", "transient"],
  EPIPE: ["network_reset", "transient"],
  ConnectionClosed: ["network_reset", "transient"],
  UND_ERR_SOCKET: ["network_reset", "transient"],
  ETIMEDOUT: ["network_timeout", "transient"],
  UND_ERR_CONNECT_TIMEOUT: ["network_timeout", "transient"],
  EAI_AGAIN: ["dns_unavailable", "transient"],
  ECONNREFUSED: ["connection_refused", "defect"],
  FailedToOpenSocket: ["socket_open_failed", "defect"],
} as const satisfies Record<keyof typeof NETWORK_ERROR_CODE_REASON, Expected>;

const HANDLER_STATUS_EXPECTED = {
  400: ["request_invalid", "client"],
  401: ["access_denied", "client"],
  402: ["usage_limited", "client"],
  403: ["access_denied", "client"],
  404: ["not_found", "client"],
  409: ["conflict", "client"],
  413: ["request_invalid", "client"],
  422: ["request_invalid", "client"],
  428: ["precondition_required", "client"],
  429: ["rate_limited", "client"],
} as const satisfies Record<
  keyof typeof HANDLER_CLIENT_STATUS_REASON,
  Expected
>;

const CLIENT_STATUSES = [
  400, 401, 402, 403, 404, 409, 413, 422, 428, 429,
] as const satisfies readonly (keyof typeof HANDLER_STATUS_EXPECTED)[];

const entriesOf = <TKey extends string | number, TValue>(
  record: Record<TKey, TValue>,
): [string, TValue][] => Object.entries<TValue>(record);

const codeSetRows = (): GradingRow[] => [
  ...entriesOf(SQL_STATE_EXPECTED).flatMap(([sqlState, [reason, grade]]) => [
    {
      name: `Bun driver SQLSTATE ${sqlState} under a query wrapper`,
      error: () => drizzle(bunPgError(sqlState)),
      reason,
      grade,
    },
    {
      name: `pg protocol SQLSTATE ${sqlState}`,
      error: () => pgProtocolError(sqlState),
      reason,
      grade,
    },
  ]),
  ...UNGRADED_SQL_STATES.flatMap((sqlState) => [
    {
      name: `ungraded Bun SQLSTATE ${sqlState}`,
      error: () => drizzle(bunPgError(sqlState)),
      reason: "unclassified" as const,
      grade: "defect" as const,
    },
    {
      name: `ungraded pg protocol SQLSTATE ${sqlState}`,
      error: () => pgProtocolError(sqlState),
      reason: "unclassified" as const,
      grade: "defect" as const,
    },
  ]),
  ...entriesOf(PG_DRIVER_EXPECTED).map(([code, [reason, grade]]) => ({
    name: `pg driver ${code}`,
    error: () => bunPgDriverError(code),
    reason,
    grade,
  })),
  ...entriesOf(REDIS_EXPECTED).map(([code, [reason, grade]]) => ({
    name: `Valkey ${code}`,
    error: () => codedError(code),
    reason,
    grade,
  })),
  ...entriesOf(NETWORK_EXPECTED).map(([code, [reason, grade]]) => ({
    name: `network ${code}`,
    error: () => codedError(code),
    reason,
    grade,
  })),
  ...CLIENT_STATUSES.map((status) => ({
    name: `HandlerError ${status}`,
    error: () => new HandlerError({ status, message: SENTINEL }),
    reason: HANDLER_STATUS_EXPECTED[status][0],
    grade: HANDLER_STATUS_EXPECTED[status][1],
    rule: "handler_status" as const,
  })),
];

// Written out per provider case, not read from the classifier.
type ProviderCaseName = (typeof PROVIDER_FAILURE_CASES)[number]["name"];

const PROVIDER_REASONS = {
  "an exhausted quota": "quota_exhausted",
  "an upstream billing stop": "provider_billing",
  "a rejected credential": "provider_credentials_rejected",
} as const satisfies Record<ProviderCaseName, FailureReason>;
const PROVIDER_GRADES = {
  "an exhausted quota": "transient",
  "an upstream billing stop": "anticipated",
  "a rejected credential": "anticipated",
} as const satisfies Record<ProviderCaseName, FailureGrade>;

// A provider case's own cause is a shared constant: classifying it at the AI
// boundary would leak into every other test, so each row gets a copy.
const freshCause = (cause: unknown): unknown =>
  cause instanceof Error
    ? Object.assign(
        new Error(cause.message),
        Object.fromEntries(Object.entries(cause)),
      )
    : structuredClone(cause);

const GRADING_ROWS: readonly GradingRow[] = [
  ...codeSetRows(),
  {
    name: "a SQLSTATE-shaped code on a plain object is not pg evidence",
    error: () => ({ code: "57P01" }),
    reason: "unclassified",
    grade: "defect",
  },
  {
    name: "a refused pg connection stays a defect",
    error: () => bunPgDriverError("ERR_POSTGRES_CONNECTION_REFUSED"),
    reason: "unclassified",
    grade: "defect",
  },
  {
    name: "an idle-timeout Valkey client is not transient",
    error: () => codedError("ERR_REDIS_IDLE_TIMEOUT"),
    reason: "unclassified",
    grade: "defect",
  },
  {
    name: "a Node system error reset",
    error: () => codedError("ECONNRESET", { errno: -54, syscall: "read" }),
    reason: "network_reset",
    grade: "transient",
  },
  {
    name: "a reset under a Result.gen panic stays greppable",
    error: () => new Panic({ message: "gen", cause: codedError("ECONNRESET") }),
    reason: "network_reset",
    grade: "transient",
    rule: "infra_under_panic",
  },
  {
    name: "a DOMException timeout with an empty stack",
    error: () => new DOMException(SENTINEL, "TimeoutError"),
    reason: "timeout_unbounded",
    grade: "defect",
  },
  {
    name: "this service's own TimeoutError",
    error: () =>
      new TimeoutError({ message: SENTINEL, label: "probe", timeoutMs: 5 }),
    reason: "timeout_unbounded",
    grade: "defect",
  },
  {
    name: "an AbortError without request-abort evidence",
    error: () => new DOMException(SENTINEL, "AbortError"),
    reason: "unclassified",
    grade: "defect",
  },
  {
    name: "a HandlerError 502 carrying a provider 429 code",
    error: () =>
      new HandlerError({ status: 502, code: "429", message: SENTINEL }),
    reason: "unclassified",
    grade: "defect",
  },
  {
    name: "an upstream_unavailable HandlerError",
    error: () =>
      new HandlerError({
        status: 502,
        code: "upstream_unavailable",
        message: SENTINEL,
      }),
    reason: "upstream_unavailable",
    grade: "transient",
    rule: "handler_code",
  },
  {
    name: "a HandlerError status through three transport wrappers",
    error: () =>
      new Panic({
        message: "a",
        cause: new UnhandledException({
          cause: new Panic({
            message: "c",
            cause: new HandlerError({ status: 404, message: SENTINEL }),
          }),
        }),
      }),
    reason: "not_found",
    grade: "client",
  },
  {
    name: "a HandlerError status four wrappers down is not the answer",
    error: () =>
      new Panic({
        message: "a",
        cause: new Panic({
          message: "b",
          cause: new UnhandledException({
            cause: new Panic({
              message: "d",
              cause: new HandlerError({ status: 404, message: SENTINEL }),
            }),
          }),
        }),
      }),
    reason: "unclassified",
    grade: "defect",
  },
  {
    name: "a HandlerError under a plain Error is answered 500, so graded so",
    error: () =>
      new Error("wrap", {
        cause: new HandlerError({ status: 404, message: SENTINEL }),
      }),
    reason: "unclassified",
    grade: "defect",
  },
  {
    name: "the RLS denial class",
    error: () => new DatabaseRlsError({ message: SENTINEL }),
    reason: "rls_denied",
    grade: "defect",
    rule: "brand",
  },
  {
    name: "an empty completion",
    error: () => new ChatEmptyCompletionError({ message: SENTINEL }),
    reason: "chat_empty_completion",
    grade: "anticipated",
  },
  {
    name: "a detected loop",
    error: () => new ChatLoopDetectedError({ message: SENTINEL }),
    reason: "chat_loop_detected",
    grade: "anticipated",
  },
  {
    name: "a cancelled generation under a transport wrapper",
    error: () =>
      new UnhandledException({
        cause: new AIGenerationCancelledError({ message: SENTINEL }),
      }),
    reason: "generation_cancelled",
    grade: "anticipated",
  },
  {
    name: "a cancellation deeper than the immediate wrapper stays visible",
    error: () =>
      new HandlerError({
        status: 502,
        message: SENTINEL,
        cause: new WorkflowIntegrationError({
          message: SENTINEL,
          cause: new AIGenerationCancelledError({ message: SENTINEL }),
        }),
      }),
    reason: "unclassified",
    grade: "defect",
  },
  {
    name: "an outer classification wins over a conflicting deep one",
    error: () =>
      classifyFailure(
        new HandlerError({
          status: 502,
          message: SENTINEL,
          cause: new ChatEmptyCompletionError({ message: SENTINEL }),
        }),
        "upstream_unavailable",
      ),
    reason: "upstream_unavailable",
    grade: "transient",
    rule: "brand",
  },
  ...PROVIDER_FAILURE_CASES.flatMap(({ name, cause }): GradingRow[] => [
    {
      name: `${name} through aiHandlerError`,
      error: () =>
        aiHandlerError(modelStepFailure(freshCause(cause)), {
          status: 500,
          message: "fallback",
        }),
      reason: PROVIDER_REASONS[name],
      grade: PROVIDER_GRADES[name],
      rule: "brand" as const,
    },
    {
      name: `${name} bare at the AI boundary`,
      error: () => freshCause(cause),
      boundary: "ai" as const,
      reason: PROVIDER_REASONS[name],
      grade: PROVIDER_GRADES[name],
      rule: "brand" as const,
    },
  ]),
  {
    name: "a bare provider 429 that never met the AI boundary",
    error: () => Object.assign(new Error(SENTINEL), { statusCode: 429 }),
    reason: "unclassified",
    grade: "defect",
  },
  {
    name: "a Bedrock ThrottlingException at the AI boundary",
    error: () => awsException("ThrottlingException", 400),
    boundary: "ai",
    reason: "quota_exhausted",
    grade: "transient",
  },
  {
    name: "a Bedrock ModelNotReadyException at the AI boundary",
    error: () => awsException("ModelNotReadyException", 429),
    boundary: "ai",
    reason: "provider_unavailable",
    grade: "transient",
  },
  {
    name: "a Bedrock ThrottlingException through aiHandlerError",
    error: () =>
      aiHandlerError(awsException("ThrottlingException", 400), {
        status: 500,
        message: "fallback",
      }),
    reason: "quota_exhausted",
    grade: "transient",
  },
  {
    name: "a Bedrock ModelNotReadyException through aiHandlerError",
    error: () =>
      aiHandlerError(awsException("ModelNotReadyException", 429), {
        status: 500,
        message: "fallback",
      }),
    reason: "provider_unavailable",
    grade: "transient",
  },
  {
    name: "a request validation failure the framework answered",
    error: () => ({ type: "body" }),
    request: {
      answeredStatus: 422,
      framework: elysiaFailureReason("VALIDATION", { type: "body" }),
    },
    reason: "request_validation",
    grade: "client",
    rule: "framework",
  },
  {
    name: "a route the framework did not find",
    error: () => new Error("NOT_FOUND"),
    request: {
      answeredStatus: 404,
      framework: elysiaFailureReason("NOT_FOUND", undefined),
    },
    reason: "route_not_found",
    grade: "client",
  },
  {
    name: "a body the framework could not parse",
    error: () => new Error("PARSE"),
    request: {
      answeredStatus: 400,
      framework: elysiaFailureReason("PARSE", undefined),
    },
    reason: "request_malformed",
    grade: "client",
  },
  {
    name: "a handler output that broke its own response schema",
    error: () => ({ type: "response" }),
    request: {
      answeredStatus: 500,
      framework: elysiaFailureReason("VALIDATION", { type: "response" }),
    },
    reason: "response_invalid",
    grade: "defect",
  },
  {
    name: "a thrown string",
    error: () => SENTINEL,
    reason: "unclassified",
    grade: "defect",
  },
  {
    name: "a thrown null",
    error: () => null,
    reason: "unclassified",
    grade: "defect",
  },
];

const materialize = (row: GradingRow): unknown => {
  const error = row.error();
  if (row.boundary === "ai") {
    classifyAIBoundaryFailure(error);
  }
  return error;
};

const grade = (row: GradingRow, error = materialize(row)) =>
  gradeFailure(readEvidence(error), SINK, row.request);

describe("failure grading", () => {
  test.each(GRADING_ROWS.map((row) => [row.name, row] as const))(
    "%s",
    (_name, row) => {
      const grading = grade(row);

      expect({ reason: grading.reason, grade: grading.grade }).toEqual({
        reason: row.reason,
        grade: row.grade,
      });
      if (row.rule !== undefined) {
        expect(grading.rule).toBe(row.rule);
      }
    },
  );

  test("every client status is exercised", () => {
    expect(CLIENT_STATUSES.map(String)).toEqual(
      Object.keys(HANDLER_STATUS_EXPECTED),
    );
  });

  test("every provider case is written out", () => {
    expect(Object.keys(PROVIDER_REASONS).toSorted()).toEqual(
      PROVIDER_FAILURE_CASES.map(({ name }) => name).toSorted(),
    );
  });

  test("the request pipeline and the grader resolve the same HandlerError", () => {
    for (const row of GRADING_ROWS) {
      const error = materialize(row);
      const resolved = resolveHandlerError(error);
      const grading = grade(row, error);
      if (
        resolved !== null &&
        resolved.status < 500 &&
        grading.rule !== "brand"
      ) {
        expect(grading.rule).toBe("handler_status");
      }
      if (resolved === null) {
        expect(grading.rule).not.toBe("handler_status");
      }
    }
  });
});

describe("wrapper properties", () => {
  const unwrapped = GRADING_ROWS.filter((row) => row.request === undefined);

  test("a transport wrapper leaves every reason unchanged while the answer is", () => {
    for (const row of unwrapped) {
      const inner = materialize(row);
      for (const wrapped of [
        new UnhandledException({ cause: inner }),
        new Panic({ message: "gen", cause: inner }),
      ]) {
        // Past the pipeline's wrapper depth the answer itself changes; the
        // grade follows the answer, not the other way round.
        if (resolveHandlerError(wrapped) !== resolveHandlerError(inner)) {
          continue;
        }
        expect([row.name, grade(row, wrapped).reason]).toEqual([
          row.name,
          row.reason,
        ]);
      }
    }
  });

  test("a generic wrapper leaves every reason not decided by a handler status", () => {
    for (const row of unwrapped) {
      const inner = materialize(row);
      if (resolveHandlerError(inner) !== null) {
        continue;
      }
      const wrappers =
        inner instanceof Error
          ? [new Error("wrap", { cause: inner }), drizzle(inner)]
          : [new Error("wrap", { cause: inner })];
      for (const wrapped of wrappers) {
        expect([row.name, grade(row, wrapped).reason]).toEqual([
          row.name,
          row.reason,
        ]);
      }
    }
  });

  test("a wrapper of its own class can declare a new meaning", () => {
    class BudgetedLockTimeoutError extends Error {
      constructor(message: string, options: ErrorOptions) {
        super(message, options);
        this.name = "BudgetedLockTimeoutError";
      }
    }
    declareFailureClass(BudgetedLockTimeoutError, "pg_lock_timeout_budgeted");
    const error = new BudgetedLockTimeoutError("phase", {
      cause: drizzle(bunPgError("55P03")),
    });

    expect(gradeFailure(readEvidence(error), SINK)).toMatchObject({
      reason: "pg_lock_timeout_budgeted",
      grade: "transient",
      rule: "brand",
    });
  });

  test("a brand deep in the chain does not rescue an outer defect", () => {
    const deep = new HandlerError({
      status: 502,
      message: "wrapped",
      cause: new ChatEmptyCompletionError({ message: "x" }),
    });
    const evidence = readEvidence(deep);

    expect(gradeFailure(evidence, SINK).reason).toBe("unclassified");
    expect(errorFields(evidence)["error.chain.1.brand"]).toBe(
      "chat_empty_completion",
    );
  });
});

describe("sink expectations", () => {
  type ExpectedExample = {
    readonly error: () => unknown;
    readonly request?: FailureRequestState;
  };
  type ExpectedCase = {
    readonly expectation: FailureExpectation;
    readonly positive: ExpectedExample;
    readonly negative: ExpectedExample;
  };

  const EXPECTED_REASON_CASES = {
    optional_file_absent: {
      expectation: {
        match: { code: "ENOENT" },
        reason: "optional_file_absent",
      },
      positive: {
        error: () => codedError("ENOENT", { errno: -2, syscall: "open" }),
      },
      negative: {
        error: () => codedError("EACCES", { errno: -13, syscall: "open" }),
      },
    },
    client_disconnected: {
      expectation: {
        match: { requestAborted: true },
        reason: "client_disconnected",
      },
      positive: {
        error: () => new DOMException("aborted", "AbortError"),
        request: { requestAborted: true },
      },
      negative: {
        error: () => new DOMException("aborted", "AbortError"),
        request: { requestAborted: false },
      },
    },
  } as const satisfies Record<ExpectedReason, ExpectedCase>;

  const expectedCases: [string, ExpectedCase][] = entriesOf(
    EXPECTED_REASON_CASES,
  );

  test.each(expectedCases)(
    "%s has a positive and a negative case",
    (reason, { expectation, positive, negative }) => {
      const sink = failureSink({ event: "expecting", expected: [expectation] });

      expect(
        gradeFailure(readEvidence(positive.error()), sink, positive.request)
          .reason,
      ).toBe(reason);
      expect(
        gradeFailure(readEvidence(negative.error()), sink, negative.request)
          .reason,
      ).toBe("unclassified");
    },
  );

  test("an expectation cannot override a classification", () => {
    const sink = failureSink({
      event: "expecting",
      expected: [{ match: { code: "ENOENT" }, reason: "optional_file_absent" }],
    });
    const error = classifyFailure(codedError("ENOENT"), "pg_auth_failed");

    expect(gradeFailure(readEvidence(error), sink).reason).toBe(
      "pg_auth_failed",
    );
  });

  test("a generic wrapper with a code of its own is the failure node", () => {
    const sink = failureSink({
      event: "expecting",
      expected: [{ match: { code: "ENOENT" }, reason: "optional_file_absent" }],
    });
    const coded = Object.assign(
      new Error("read failed", { cause: new Error("inner") }),
      { code: "ENOENT" },
    );
    const bare = new Error("read failed", { cause: codedError("ENOENT") });

    expect(gradeFailure(readEvidence(coded), sink).reason).toBe(
      "optional_file_absent",
    );
    // A bare wrapper stays transparent, so its cause is what the sink sees.
    expect(gradeFailure(readEvidence(bare), sink).reason).toBe(
      "optional_file_absent",
    );
  });

  test("an owned constructor matches one level below the failure node only when asked", () => {
    class OptionalReadError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "OptionalReadError";
      }
    }
    const shallow = failureSink({
      event: "shallow",
      expected: [
        { match: { ctor: OptionalReadError }, reason: "optional_file_absent" },
      ],
    });
    const deep = failureSink({
      event: "deep",
      expected: [
        {
          match: { ctor: OptionalReadError },
          depth: 1,
          reason: "optional_file_absent",
        },
      ],
    });
    const error = new WorkflowIntegrationError({
      message: "x",
      cause: new OptionalReadError("missing"),
    });

    expect(gradeFailure(readEvidence(error), shallow).reason).toBe(
      "unclassified",
    );
    expect(gradeFailure(readEvidence(error), deep).reason).toBe(
      "optional_file_absent",
    );
  });
});

describe("the observation reads the boundary's decision, not the classifier", () => {
  test("a provider status past the snapshot depth still grades by its brand", () => {
    let error: unknown = Object.assign(new Error("provider"), {
      statusCode: 429,
    });
    for (let level = 0; level < 8; level++) {
      error = new Error(`wrap ${level}`, { cause: error });
    }
    const unbranded = new Error("wrap", { cause: error });

    // The classifier walks unbounded; the snapshot stops at six levels.
    expect(classifyAIError(error)).toBe("quota_exhausted");
    expect(gradeFailure(readEvidence(unbranded), SINK).reason).toBe(
      "unclassified",
    );
    classifyAIBoundaryFailure(error);
    expect(gradeFailure(readEvidence(error), SINK).reason).toBe(
      "quota_exhausted",
    );
  });

  test("aiHandlerError classifies before it wraps", () => {
    for (const { cause, status } of PROVIDER_FAILURE_CASES) {
      const answered = aiHandlerError(modelStepFailure(cause), {
        status: 500,
        message: "fallback",
      });

      expect(answered.status).toBe(status);
      expect(readEvidence(answered).nodes[0]?.brand?.source).toBe("instance");
    }
  });

  test("an unknown failure keeps the caller's fallback unclassified", () => {
    const answered = aiHandlerError(new Error("unrelated"), {
      status: 500,
      message: "fallback",
    });

    expect(readEvidence(answered).nodes[0]?.brand).toBeUndefined();
  });
});

// --- Frozen legacy comparison -------------------------------------------------

const withoutShadow = (
  fields: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(fields).filter(([key]) => !key.startsWith("failure.")),
  );

type LegacyRow = {
  readonly name: string;
  readonly error: () => unknown;
  /** Its top frame lies outside this build's paths: shipped as "". */
  readonly unrecognizedFrame?: true;
};

const LEGACY_ROWS: readonly LegacyRow[] = [
  ...GRADING_ROWS.map(({ name, error }) => ({ name, error })),
  { name: "a plain object", error: () => ({ code: SENTINEL, status: 503 }) },
  {
    name: "a plain object between Errors",
    error: () =>
      new Error("outer", {
        cause: { cause: codedError("ECONNRESET"), status: 502 },
      }),
  },
  {
    name: "a plain object between pg nodes",
    error: () =>
      drizzle(
        Object.assign(new Error("mid"), {
          cause: {
            code: "23505",
            constraint: "users_email_key",
            cause: bunPgError("23505"),
          },
        }),
      ),
  },
  {
    name: "a Bedrock $metadata status",
    error: () =>
      new Error("wrap", { cause: awsException("ValidationException", 400) }),
  },
  {
    name: "a RUN_ERROR numeric-string code",
    error: () =>
      new HandlerError({ status: 502, message: "run", cause: { code: "503" } }),
  },
  {
    name: "a numeric errno and a syscall",
    error: () => codedError("EPIPE", { errno: -32, syscall: "write" }),
  },
  {
    name: "a primitive cause",
    error: () => new Error("x", { cause: SENTINEL }),
  },
  {
    name: "a self-caused error",
    error: () => {
      const error = new Error("self");
      error.cause = error;
      return error;
    },
  },
  {
    name: "a message-less error",
    error: () => new HandlerError({ status: 500, message: "" }),
  },
  {
    name: "an eval'd frame",
    error: evalFrameError,
    unrecognizedFrame: true,
  },
];

describe("fields stay compatible with the frozen legacy helpers", () => {
  test.each(LEGACY_ROWS.map((row) => [row.name, row] as const))(
    "%s",
    (_name, row) => {
      const error = row.error();
      const legacyFingerprint = legacy.errorFingerprint(error);
      const expectedFingerprint =
        row.unrecognizedFrame === true
          ? { ...legacyFingerprint, "error.frame": "" }
          : legacyFingerprint;

      expect(withoutShadow(errorFingerprint(error))).toEqual(
        expectedFingerprint,
      );
      expect(withoutShadow(errorSystemFields(error))).toEqual(
        legacy.errorSystemFields(error),
      );
      expect(withoutShadow(pgErrorFields(error))).toEqual(
        legacy.pgErrorFields(error),
      );
      expect(withoutShadow(providerStatusFields(error))).toEqual(
        legacy.providerStatusFields(error),
      );
      const evidence = readEvidence(error);
      if (error instanceof Error) {
        expect(causeChainAttributes(evidence)).toEqual(
          legacy.errorCauseChainAttributes(error),
        );
      }

      // The owner's full record carries every legacy key, value and type.
      const legacyUnion: Record<string, number | string> = {
        ...legacy.errorSystemFields(error),
        ...(error instanceof Error
          ? {
              ...(legacy.getErrorStatusCode(error) === undefined
                ? {}
                : {
                    "error.status_code": legacy.getErrorStatusCode(error) ?? 0,
                  }),
              ...legacy.errorCauseChainAttributes(error),
            }
          : {}),
        ...legacy.providerStatusFields(error),
        ...expectedFingerprint,
      };
      const fields = errorFields(evidence);
      for (const [key, value] of Object.entries(legacyUnion)) {
        expect([key, fields[key]]).toEqual([key, value]);
      }
      expect(
        legacy.legacyErrorIdentity(withoutShadow(errorFingerprint(error))),
      ).toBe(legacy.legacyErrorIdentity(expectedFingerprint));
    },
  );

  test("the frame filter only blanks a frame, it never drops the key", () => {
    const row = LEGACY_ROWS.find((candidate) => candidate.unrecognizedFrame);
    const error = row?.error();

    expect(legacy.errorFingerprint(error)["error.frame"]).toContain(SENTINEL);
    expect(errorFingerprint(error)["error.frame"]).toBe("");
  });

  test("a provider status deeper than the snapshot is the one other difference", () => {
    let error: unknown = { statusCode: 503 };
    for (let level = 0; level < 7; level++) {
      error = new Error(`wrap ${level}`, { cause: error });
    }

    expect(legacy.providerStatusFields(error)).toEqual({
      "error.provider.status": "503",
    });
    expect(withoutShadow(providerStatusFields(error))).toEqual({});
    expect(errorFields(readEvidence(error))["error.truncation"]).toBe("depth");
  });

  test("hostile values the legacy helpers threw on now read as failed reads", () => {
    const { proxy, revoke } = Proxy.revocable(new Error("x"), {});
    revoke();

    expect(() => legacy.errorFingerprint(proxy)).toThrow(TypeError);
    expect(errorFingerprint(proxy)).toMatchObject({
      "error.class": "UnknownError",
    });
    expect(errorFields(readEvidence(proxy))["error.truncation"]).toBe(
      "read_failed",
    );
  });
});

describe("canonical fields", () => {
  test("carry the SQLSTATE and the provider status with provenance", () => {
    const fields = errorFields(
      readEvidence(
        new HandlerError({
          status: 502,
          code: "429",
          message: "x",
          cause: drizzle(bunPgError("40001")),
        }),
      ),
    );

    expect(fields).toMatchObject({
      "error.sqlstate": "40001",
      "error.sqlstate_depth": 2,
      "error.provider.status": "429",
      "error.provider.status_source": "code",
      "error.provider.status_depth": 0,
      "error.chain.1.type": "DrizzleQueryError",
      "error.chain.2.type": "PostgresError",
      "error.chain.2.code": "ERR_POSTGRES_SERVER_ERROR",
      "error.chain.2.sqlstate": "40001",
      "error.chain_depth": 3,
      "error.truncation": "none",
    });
    expect(fields["error.chain.0.type"]).toBeUndefined();
  });

  test("a code without provenance ships as other", () => {
    const fields = errorFields(
      readEvidence(new Error("wrap", { cause: codedError(SENTINEL) })),
    );

    expect(fields["error.chain.1.code"]).toBe("other");
  });

  test("every key survives the logger's sanitizer", async () => {
    const { sanitizeLogAttributes } =
      await import("@/api/lib/observability/logger");
    for (const row of LEGACY_ROWS) {
      const fields = errorFields(readEvidence(row.error()));

      expect(sanitizeLogAttributes(fields)).toEqual(fields);
    }
  });
});

// --- Channels, through the real recorders -------------------------------------

const OUTPUT_BY_GRADE = {
  anticipated: { severity: "WARN", captures: 0 },
  transient: { severity: "WARN", captures: 0 },
  client: { severity: "WARN", captures: 0 },
  defect: { severity: "ERROR", captures: 1 },
} as const satisfies Record<
  FailureGrade,
  { severity: string; captures: number }
>;

const scopedRequest = (): Request => {
  const request = new Request("https://api.test/v1/contract");
  initRequestContext(request);
  return request;
};

describe("observeFailure channels", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;
  let metricLines: string[];

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
    metricLines = [];
    setMetricLineSinkForTesting((line) => {
      metricLines.push(line);
    });
    resetFailureObservationsForTesting();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
    resetMetricLineSinkForTesting();
    resetFailureObservationsForTesting();
  });

  const ungated = GRADING_ROWS.filter((row) => row.request === undefined);

  test.each(ungated.map((row) => [row.name, row] as const))(
    "%s follows its grade's output policy",
    (_name, row) => {
      const expected = OUTPUT_BY_GRADE[row.grade];
      const request = scopedRequest();

      observeFailure(materialize(row), { sink: SINK, request });

      expect(logs.records.map(({ severityText }) => severityText)).toEqual([
        expected.severity,
      ]);
      expect(logs.records[0]?.attributes).toMatchObject({
        "failure.grade": row.grade,
        "failure.reason": row.reason,
        "failure.policy": "grade",
      });
      expect(analytics.exceptions()).toHaveLength(expected.captures);
      expect(metricLines).toHaveLength(row.grade === "transient" ? 1 : 0);
    },
  );

  test("no non-defect row reaches the exception tracker or an ERROR record", () => {
    for (const row of ungated.filter(({ grade: g }) => g !== "defect")) {
      observeFailure(materialize(row), { sink: SINK });
    }

    expect(analytics.exceptions()).toEqual([]);
    expect(logs.at("ERROR")).toEqual([]);
  });

  test("a legacy pin keeps the site's output whatever the grade", () => {
    const pinned = failureSink({
      event: "pinned",
      expected: [],
      legacy: { severity: "ERROR", capture: true },
    });

    observeFailure(codedError("ECONNRESET"), { sink: pinned });

    expect(logs.records).toEqual([
      expect.objectContaining({
        severityText: "ERROR",
        attributes: expect.objectContaining({
          "failure.grade": "transient",
          "failure.policy": "legacy",
        }),
      }),
    ]);
    expect(analytics.exceptions()).toHaveLength(1);
  });

  test("a sustained transient episode raises the severity, not the capture", () => {
    observeFailure(codedError("ECONNRESET"), {
      sink: SINK,
      escalation: "sustained",
    });

    expect(logs.at("ERROR")).toHaveLength(1);
    expect(analytics.exceptions()).toEqual([]);
  });

  test("the transient metric carries only the sink and the reason", () => {
    observeFailure(codedError("ECONNRESET"), {
      sink: SINK,
      request: scopedRequest(),
    });

    const [line] = metricLines;
    expect(JSON.parse(line ?? "{}")).toMatchObject({
      _aws: {
        CloudWatchMetrics: [
          {
            Namespace: "Stella/Api",
            Dimensions: [["sink", "reason"], []],
            Metrics: [{ Name: "RequestTransientFailures", Unit: "Count" }],
          },
        ],
      },
      sink: "contract.sink",
      reason: "network_reset",
      RequestTransientFailures: 1,
    });
    expect(Object.keys(JSON.parse(line ?? "{}")).toSorted()).toEqual([
      "RequestTransientFailures",
      "_aws",
      "reason",
      "sink",
    ]);
  });

  test("a context override of owned fields is rejected", () => {
    const hostileContext: Record<string, string> = {
      "failure.grade": "anticipated",
      $exception_fingerprint: "spoofed",
      "error.class": "Spoofed",
      threadId: "thread-1",
    };
    const error = codedError("EACCES");

    observeFailure(error, { sink: SINK, ctx: hostileContext });
    observeFailure(error, { sink: SINK, ctx: hostileContext });

    const [record] = logs.records;
    expect(record?.attributes).toMatchObject({
      "failure.grade": "defect",
      "failure.ctx_rejected": 3,
      threadId: "thread-1",
      "error.class": "Error",
    });
    const [exception] = analytics.exceptions();
    expect(exception?.properties["$exception_fingerprint"]).toBe(
      legacy.legacyErrorIdentity(legacy.errorFingerprint(error)),
    );
    // Suppression keys on that same identity: the second capture is throttled.
    expect(analytics.exceptions()).toHaveLength(1);
  });

  test("the aggregate counts every observation before capture suppression", () => {
    const error = codedError("EACCES");
    for (let index = 0; index < 5; index++) {
      observeFailure(error, { sink: SINK });
    }
    logs.records.length = 0;

    flushFailureObservations();

    expect(analytics.exceptions()).toHaveLength(1);
    expect(logs.records).toEqual([
      {
        severityText: "INFO",
        message: "failure.observed",
        attributes: {
          "failure.sink": "contract.sink",
          "failure.grade": "defect",
          "failure.reason": "unclassified",
          "failure.legacy_channel": "log_error_and_capture",
          "error.fingerprint_degraded": "none",
          occurrences: 5,
        },
      },
    ]);
  });
});

describe("privileged content never leaves the process", () => {
  let analytics: RecordingAnalytics;
  let logs: RecordingLogger;
  let metricLines: string[];

  beforeEach(() => {
    analytics = installRecordingAnalytics();
    logs = installRecordingLogger();
    metricLines = [];
    setMetricLineSinkForTesting((line) => {
      metricLines.push(line);
    });
    resetFailureObservationsForTesting();
  });

  afterEach(() => {
    analytics.restore();
    logs.restore();
    resetMetricLineSinkForTesting();
    resetFailureObservationsForTesting();
  });

  const SENTINEL_ERRORS: readonly (readonly [string, () => unknown])[] = [
    [
      "the message",
      () =>
        new Error(
          `${SENTINEL}\n    at x (/app/apps/api/src/${SENTINEL}.ts:1:2)`,
        ),
    ],
    ["pg detail and query", () => drizzle(bunPgError("23505"))],
    [
      "a provider body",
      () =>
        new HandlerError({
          status: 502,
          message: SENTINEL,
          cause: {
            error: {
              message: SENTINEL,
              code: "invalid_api_key",
              type: SENTINEL,
            },
          },
        }),
    ],
    [
      "a fetch boundary url, body and status text",
      () =>
        new FetchBoundaryError({
          url: `https://registry.test/${SENTINEL}`,
          status: 503,
          statusText: SENTINEL,
          body: SENTINEL,
          message: SENTINEL,
        }),
    ],
    [
      "the code of a plain body",
      () => new Error("wrap", { cause: { code: SENTINEL } }),
    ],
    [
      "a fake tag on a plain object",
      () => ({ _tag: SENTINEL, code: SENTINEL }),
    ],
    ["an eval'd stack path", evalFrameError],
    ["a transient with a sentinel message", () => codedError("ECONNRESET")],
  ];

  test("in every log record, capture payload and metric line", () => {
    const hostileContext: Record<string, string> = {
      [SENTINEL]: "value",
      note: SENTINEL,
      threadId: `${SENTINEL}${"x".repeat(200)}`,
    };
    for (const [, make] of SENTINEL_ERRORS) {
      const error = make();
      const request = scopedRequest();
      const defect = failureSink({ event: "sentinel.defect", expected: [] });
      observeFailure(error, { sink: defect, request, ctx: hostileContext });
      captureError(error);
      logger.warn("helper.record", {
        ...errorSystemFields(error),
        ...pgErrorFields(error),
        ...errorFingerprint(error),
        ...providerStatusFields(error),
      });
    }
    flushFailureObservations();

    const emitted = JSON.stringify({
      records: logs.records,
      events: analytics.events,
      metricLines,
    });
    expect(analytics.exceptions().length).toBeGreaterThan(0);
    expect(metricLines.length).toBeGreaterThan(0);
    expect(emitted).not.toContain(SENTINEL);
  });
});
