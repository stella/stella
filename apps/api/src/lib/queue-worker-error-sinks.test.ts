import { Glob } from "bun";
import { describe, expect, test } from "bun:test";

/**
 * The throttle only holds if every worker's `error` event goes through it: one
 * queue logging the event directly restores the unbounded storm for that queue
 * alone, which is invisible until an outage. The call sites cannot be checked
 * by type (the handler is an ordinary callback), so the invariant is asserted
 * over the source instead of trusting each new queue to remember.
 */
const RAW_WORKER_ERROR_SINK = /logger\.error\(\s*"[a-z_]+\.worker_error"/gu;

const API_SRC = new URL("../..", import.meta.url).pathname;

describe("queue worker error sinks", () => {
  test("no queue logs a worker_error event outside the throttled helper", async () => {
    const offenders: string[] = [];
    for await (const relativePath of new Glob("src/**/*.ts").scan(API_SRC)) {
      if (relativePath.endsWith(".test.ts")) {
        continue;
      }
      const source = await Bun.file(`${API_SRC}${relativePath}`).text();
      if (RAW_WORKER_ERROR_SINK.test(source)) {
        offenders.push(relativePath);
      }
      // `test` on a /g/ regex advances `lastIndex`, so a stale offset would
      // silently skip matches in the files that follow.
      RAW_WORKER_ERROR_SINK.lastIndex = 0;
    }

    expect(offenders).toEqual([]);
  });
});
