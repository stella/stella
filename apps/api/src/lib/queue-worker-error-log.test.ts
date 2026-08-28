import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

type LoggedCall = { event: string; attributes: Record<string, unknown> };

const logged: LoggedCall[] = [];

// Spread the real module: mock.module is process-global, so a partial mock
// would delete the logger's other exports for every later test file.
const realLogger = await import("@/api/lib/observability/logger");
void mock.module("@/api/lib/observability/logger", () => ({
  ...realLogger,
  logger: {
    ...realLogger.logger,
    error: (event: string, attributes?: Record<string, unknown>) => {
      logged.push({ event, attributes: attributes ?? {} });
    },
  },
}));

const { createQueueWorkerErrorLogger } =
  await import("@/api/lib/queue-worker-error-log");

const withCode = (code: string): Error =>
  Object.assign(new Error("Connection closed"), { code });

const TRANSIENT = "ERR_REDIS_CONNECTION_CLOSED";
const POLL_BLIP = "ERR_REDIS_INVALID_RESPONSE";
const START = new Date("2026-08-27T17:54:00.000Z");

describe("createQueueWorkerErrorLogger", () => {
  beforeEach(() => {
    logged.length = 0;
    setSystemTime(START);
  });

  afterEach(() => {
    setSystemTime();
  });

  test("logs a non-transient worker error on every occurrence", () => {
    const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

    log(withCode("ECONNREFUSED"));
    log(withCode("ECONNREFUSED"));

    expect(logged).toHaveLength(2);
    expect(logged[0]?.event).toBe("file_derivative.worker_error");
    // A defect carries no tally: it was not suppressed, so there is nothing
    // to count.
    expect(logged[0]?.attributes["occurrencesSinceLastLog"]).toBeUndefined();
  });

  test.each([TRANSIENT, POLL_BLIP])(
    "reports %s once per interval and counts the rest",
    (code) => {
      const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

      // The storm this guards against: one event per failed poll.
      for (let i = 0; i < 50_000; i += 1) {
        log(withCode(code));
      }

      expect(logged).toHaveLength(1);
      expect(logged[0]?.attributes["occurrencesSinceLastLog"]).toBe("1");

      setSystemTime(new Date(START.getTime() + 60_000));
      log(withCode(code));

      expect(logged).toHaveLength(2);
      // The 49,999 swallowed above plus this one, and the count restarts from
      // the previous line rather than accumulating.
      expect(logged[1]?.attributes["occurrencesSinceLastLog"]).toBe("50000");

      setSystemTime(new Date(START.getTime() + 120_000));
      log(withCode(code));

      expect(logged).toHaveLength(3);
      expect(logged[2]?.attributes["occurrencesSinceLastLog"]).toBe("1");
    },
  );

  test("keeps severity and the connection fields on a suppressed report", () => {
    const log = createQueueWorkerErrorLogger(
      "document_review_run.worker_error",
      {
        queueName: "document-review-run",
      },
    );

    log(withCode(TRANSIENT));

    expect(logged).toHaveLength(1);
    expect(logged[0]?.attributes).toMatchObject({
      "error.code": TRANSIENT,
      queueName: "document-review-run",
    });
  });

  test("does not let one worker's interval silence another's first report", () => {
    const first = createQueueWorkerErrorLogger("flow.worker_error");
    const second = createQueueWorkerErrorLogger("bilingual_run.worker_error");

    first(withCode(TRANSIENT));
    second(withCode(TRANSIENT));

    expect(logged.map((entry) => entry.event)).toEqual([
      "flow.worker_error",
      "bilingual_run.worker_error",
    ]);
  });

  test("still reports a defect raised during a suppressed transient episode", () => {
    const log = createQueueWorkerErrorLogger("workflow.worker_error");

    log(withCode(TRANSIENT));
    log(withCode(TRANSIENT));
    log(new Error("worker crashed"));

    // Two transients inside one interval yield one line; the defect is never
    // withheld, because only the codes classified as transient are counted.
    expect(logged).toHaveLength(2);
    expect(logged[1]?.attributes["occurrencesSinceLastLog"]).toBeUndefined();
  });
});
