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

const at = (elapsedMs: number): void => {
  setSystemTime(new Date(START.getTime() + elapsedMs));
};

type StreamOptions = {
  everyMs?: number;
  fromMs: number;
  toMs: number;
};

/**
 * Drive one worker the way a Redis disruption does: a failed poll every few
 * seconds for as long as it lasts. The gaps stay under the log interval, so
 * the whole run is a single episode.
 */
const streamTransients = (
  log: (error: unknown) => void,
  { everyMs = 10_000, fromMs, toMs }: StreamOptions,
): void => {
  for (let elapsed = fromMs; elapsed <= toMs; elapsed += everyMs) {
    at(elapsed);
    log(withCode(TRANSIENT));
  }
};

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

  test("logs a non-transient worker error as an error on every occurrence", () => {
    const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

    log(withCode("ECONNREFUSED"));
    log(withCode("ECONNREFUSED"));

    // A defect is not graded: it is an error from the first occurrence, with
    // no grace and no tally, because it was never suppressed.
    expect(logs.records.map((record) => record.severityText)).toEqual([
      "ERROR",
      "ERROR",
    ]);
    expect(logs.records.at(0)?.message).toBe("file_derivative.worker_error");
    expect(
      logs.records.at(0)?.attributes?.["occurrencesSinceLastLog"],
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

      expect(logs.records).toHaveLength(1);
      expect(logs.records.at(0)?.attributes?.["occurrencesSinceLastLog"]).toBe(
        "1",
      );

      at(60_000);
      log(withCode(code));

      expect(logs.records).toHaveLength(2);
      // The 49,999 swallowed above plus this one, and the count restarts from
      // the previous line rather than accumulating.
      expect(logs.records.at(1)?.attributes?.["occurrencesSinceLastLog"]).toBe(
        "50000",
      );

      at(120_000);
      log(withCode(code));

      expect(logs.records).toHaveLength(3);
      expect(logs.records.at(2)?.attributes?.["occurrencesSinceLastLog"]).toBe(
        "1",
      );
    },
  );

  test("flushes the tally at warning when the disruption stops inside the interval", async () => {
    const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

    log(withCode(TRANSIENT));
    expect(logs.records).toHaveLength(1);
    expect(logs.records.at(0)?.attributes?.["occurrencesSinceLastLog"]).toBe(
      "1",
    );

    // Land the burst just short of the boundary so the trailing flush is
    // scheduled a few ms out and a real timer can run it inside the test.
    at(59_990);
    for (let i = 0; i < 50_000; i += 1) {
      log(withCode(TRANSIENT));
    }

    // Nothing more arrives: without the trailing flush these 50,000 would be
    // stranded and the episode would read as a single occurrence.
    expect(logs.records).toHaveLength(1);

    await Bun.sleep(50);

    expect(logs.records).toHaveLength(2);
    expect(logs.records.at(1)?.attributes?.["occurrencesSinceLastLog"]).toBe(
      "50000",
    );
    // The episode healed inside the grace, so both the leading line and the
    // flush that closes it are warnings, even though the flush itself runs a
    // whole interval after the last occurrence.
    expect(logs.records.map((record) => record.severityText)).toEqual([
      "WARN",
      "WARN",
    ]);
    expect(logs.at("ERROR")).toHaveLength(0);
  });

  test("grades a trailing flush by the episode it summarizes, not by when it runs", async () => {
    const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

    streamTransients(log, { fromMs: 0, toMs: 120_000, everyMs: 60_000 });
    // Last failure just inside the grace, with the flush scheduled a few ms
    // out; the clock then moves past the grace while nothing is reported.
    at(179_990);
    log(withCode(TRANSIENT));
    at(190_000);

    await Bun.sleep(50);

    expect(logs.records.map((record) => record.severityText)).toEqual([
      "WARN",
      "WARN",
      "WARN",
      "WARN",
    ]);
    expect(logs.records.at(3)?.attributes?.["episodeAgeMs"]).toBe("179990");
  });

  test("does not flush an interval that recorded nothing", async () => {
    const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

    log(withCode(TRANSIENT));
    at(59_990);
    log(withCode(TRANSIENT));

    await Bun.sleep(50);
    expect(logs.records).toHaveLength(2);

    // The flush already drained the count, so no further line is owed.
    await Bun.sleep(50);
    expect(logs.records).toHaveLength(2);
  });

  test("escalates to an error once the episode outlasts the grace", () => {
    const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

    streamTransients(log, { fromMs: 0, toMs: 210_000 });

    // One line per interval: the onset, two still inside the grace, and one
    // past it, which is the line the error-rate signal is built on.
    expect(logs.records.map((record) => record.severityText)).toEqual([
      "WARN",
      "WARN",
      "WARN",
      "ERROR",
    ]);
    expect(
      logs.records.map((record) => record.attributes?.["episodeAgeMs"]),
    ).toEqual(["0", "60000", "120000", "180000"]);
  });

  test("starts a fresh grace window after the worker goes quiet", () => {
    const log = createQueueWorkerErrorLogger("file_derivative.worker_error");

    streamTransients(log, { fromMs: 0, toMs: 210_000 });
    expect(logs.at("ERROR")).toHaveLength(1);

    // Quiet for longer than the log interval: the worker was polling
    // successfully again, so this failure opens a new episode rather than
    // inheriting the escalated one.
    at(400_000);
    log(withCode(TRANSIENT));

    const last = logs.records.at(-1);
    expect(last?.severityText).toBe("WARN");
    expect(last?.attributes?.["episodeAgeMs"]).toBe("0");
  });

  test("keeps the connection fields on a suppressed report", () => {
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
      severityText: "WARN",
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

    expect(logs.records.map((record) => record.message)).toEqual([
      "flow.worker_error",
      "bilingual_run.worker_error",
    ]);
  });

  test("still reports a defect raised during a suppressed transient episode", () => {
    const log = createQueueWorkerErrorLogger("workflow.worker_error");

    log(withCode(TRANSIENT));
    log(withCode(TRANSIENT));
    log(new Error("worker crashed"));

    // Two transients inside one interval yield one warning; the defect is
    // neither withheld nor downgraded, because only the codes classified as
    // transient are graded.
    expect(logs.at("WARN")).toHaveLength(1);
    const errors = logs.at("ERROR");
    expect(errors).toHaveLength(1);
    expect(
      errors.at(0)?.attributes?.["occurrencesSinceLastLog"],
    ).toBeUndefined();
  });
});
