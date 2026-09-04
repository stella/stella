import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";

import { createQueueWorkerErrorLogger } from "@/api/lib/queue-worker-error-log";
import { installRecordingLogger } from "@/api/tests/helpers/recording-telemetry";
import type { RecordingLogger } from "@/api/tests/helpers/recording-telemetry";

const withCode = (code: string): Error =>
  Object.assign(new Error("Connection closed"), { code });

const TRANSIENT = "ERR_REDIS_CONNECTION_CLOSED";
const CONNECT_TIMEOUT = "ERR_REDIS_CONNECTION_TIMEOUT";
const POLL_BLIP = "ERR_REDIS_INVALID_RESPONSE";
const START = new Date("2026-08-27T17:54:00.000Z");

describe("createQueueWorkerErrorLogger", () => {
  let logs: RecordingLogger;

  beforeEach(() => {
    logs = installRecordingLogger();
    setSystemTime(START);
  });

  afterEach(() => {
    logs.restore();
    setSystemTime();
  });

  test("logs a non-transient worker error on every occurrence", () => {
    const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

    log(withCode("ECONNREFUSED"));
    log(withCode("ECONNREFUSED"));

    const errors = logs.at("ERROR");
    expect(errors).toHaveLength(2);
    expect(errors.at(0)?.message).toBe("file_derivative.worker_error");
    // A defect carries no tally: it was not suppressed, so there is nothing
    // to count.
    expect(
      errors.at(0)?.attributes?.["occurrencesSinceLastLog"],
    ).toBeUndefined();
  });

  test.each([TRANSIENT, CONNECT_TIMEOUT, POLL_BLIP])(
    "reports %s once per interval and counts the rest",
    (code) => {
      const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

      // The storm this guards against: one event per failed poll.
      for (let i = 0; i < 50_000; i += 1) {
        log(withCode(code));
      }

      expect(logs.at("ERROR")).toHaveLength(1);
      expect(
        logs.at("ERROR").at(0)?.attributes?.["occurrencesSinceLastLog"],
      ).toBe("1");

      setSystemTime(new Date(START.getTime() + 60_000));
      log(withCode(code));

      expect(logs.at("ERROR")).toHaveLength(2);
      // The 49,999 swallowed above plus this one, and the count restarts from
      // the previous line rather than accumulating.
      expect(
        logs.at("ERROR").at(1)?.attributes?.["occurrencesSinceLastLog"],
      ).toBe("50000");

      setSystemTime(new Date(START.getTime() + 120_000));
      log(withCode(code));

      expect(logs.at("ERROR")).toHaveLength(3);
      expect(
        logs.at("ERROR").at(2)?.attributes?.["occurrencesSinceLastLog"],
      ).toBe("1");
    },
  );

  test("flushes the tally when the disruption stops inside the interval", async () => {
    const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

    log(withCode(TRANSIENT));
    expect(logs.at("ERROR")).toHaveLength(1);
    expect(
      logs.at("ERROR").at(0)?.attributes?.["occurrencesSinceLastLog"],
    ).toBe("1");

    // Land the burst just short of the boundary so the trailing flush is
    // scheduled a few ms out and a real timer can run it inside the test.
    setSystemTime(new Date(START.getTime() + 59_990));
    for (let i = 0; i < 50_000; i += 1) {
      log(withCode(TRANSIENT));
    }

    // Nothing more arrives: without the trailing flush these 50,000 would be
    // stranded and the episode would read as a single occurrence.
    expect(logs.at("ERROR")).toHaveLength(1);

    await Bun.sleep(50);

    expect(logs.at("ERROR")).toHaveLength(2);
    expect(
      logs.at("ERROR").at(1)?.attributes?.["occurrencesSinceLastLog"],
    ).toBe("50000");
  });

  test("does not flush an interval that recorded nothing", async () => {
    const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

    log(withCode(TRANSIENT));
    setSystemTime(new Date(START.getTime() + 59_990));
    log(withCode(TRANSIENT));

    await Bun.sleep(50);
    expect(logs.at("ERROR")).toHaveLength(2);

    // The flush already drained the count, so no further line is owed.
    await Bun.sleep(50);
    expect(logs.at("ERROR")).toHaveLength(2);
  });

  test("keeps severity and the connection fields on a suppressed report", () => {
    const log = createQueueWorkerErrorLogger(
      "document_review_run.worker_error",
      {
        // Named `queue`, not `queueName`: the logger's PII denylist drops any
        // key matching /name/i, so the latter never reaches the sink.
        queue: "document-review-run",
      },
    );

    log(withCode(TRANSIENT));

    expect(logs.records).toHaveLength(1);
    expect(logs.records.at(0)).toMatchObject({
      severityText: "ERROR",
      message: "document_review_run.worker_error",
      attributes: {
        "error.code": TRANSIENT,
        queue: "document-review-run",
      },
    });
    expect(
      logs.records.at(0)?.attributes?.["log.attributes_dropped"],
    ).toBeUndefined();
  });

  test("does not let one worker's interval silence another's first report", () => {
    const first = createQueueWorkerErrorLogger("flow.worker_error");
    const second = createQueueWorkerErrorLogger("bilingual_run.worker_error");

    first(withCode(TRANSIENT));
    second(withCode(TRANSIENT));

    expect(logs.at("ERROR").map((record) => record.message)).toEqual([
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
    const errors = logs.at("ERROR");
    expect(errors).toHaveLength(2);
    expect(
      errors.at(1)?.attributes?.["occurrencesSinceLastLog"],
    ).toBeUndefined();
  });
});
