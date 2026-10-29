import { describe, expect, test } from "bun:test";

import type { Verdict } from "@stll/db-load-gate/health";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import type { ApiLatencyAdmission } from "@/api/lib/observability/api-latency-admission";

import {
  createVisitedReplaySignals,
  VISITED_REPLAY_LIMITS,
  type VisitedReplayCandidate,
} from "./visited-replay";

const signal = () =>
  ({
    sourceId: createSafeId<"caseLawSource">(),
    decisionId: createSafeId<"caseLawDecision">(),
  }) satisfies VisitedReplayCandidate;

const fixture = () => {
  let clock = 0;
  let localCorpus = true;
  let verdict: Verdict = { kind: "normal", signals: [] };
  let latency: ApiLatencyAdmission = {
    status: "admit",
    p95Ms: 10,
    samples: 20,
  };
  const queued: VisitedReplayCandidate[][] = [];
  const buffer = createVisitedReplaySignals({
    now: () => clock,
    usesLocalCorpus: () => localCorpus,
  });
  const options = {
    readVerdict: async () => verdict,
    readLatencyAdmission: () => latency,
    enqueueBatch: async (batch: readonly VisitedReplayCandidate[]) => {
      queued.push([...batch]);
    },
    maxDurationMs: 1000,
  };
  return {
    buffer,
    options,
    queued,
    advance: (ms: number) => {
      clock += ms;
    },
    external: () => {
      localCorpus = false;
    },
    db: (next: Verdict) => {
      verdict = next;
    },
    latency: (next: ApiLatencyAdmission) => {
      latency = next;
    },
    flush: async () => await buffer.flush(options),
  };
};

describe("visited decision replay hints", () => {
  test("reads nominate identities synchronously without writing the durable queue", async () => {
    const state = fixture();
    const visited = signal();
    expect(state.buffer.offer(visited)).toBe("buffered");
    for (let index = 0; index < 100; index += 1) {
      expect(state.buffer.offer(visited)).toBe("deduplicated");
    }
    expect(state.queued).toEqual([]);
    expect(await state.flush()).toEqual({ status: "complete", flushed: 1 });
    expect(state.queued).toEqual([[visited]]);
    expect(await state.flush()).toEqual({ status: "complete", flushed: 0 });
    expect(state.queued).toEqual([[visited]]);
  });

  test("per-source admissions enforce a sliding minute ceiling and flush with one batch write", async () => {
    const state = fixture();
    const source = signal();
    const records = Array.from(
      { length: VISITED_REPLAY_LIMITS.admissionsPerMinute },
      () => ({ ...source, decisionId: createSafeId<"caseLawDecision">() }),
    );
    for (const record of records) {
      expect(state.buffer.offer(record)).toBe("buffered");
    }
    const another = {
      ...source,
      decisionId: createSafeId<"caseLawDecision">(),
    };
    expect(state.buffer.offer(another)).toBe("rate-ceiling");
    expect(await state.flush()).toEqual({
      status: "complete",
      flushed: records.length,
    });
    expect(state.queued).toEqual([records]);
    state.advance(VISITED_REPLAY_LIMITS.windowMs - 1);
    expect(state.buffer.offer(another)).toBe("rate-ceiling");
    state.advance(1);
    expect(state.buffer.offer(another)).toBe("buffered");
    expect(await state.flush()).toEqual({ status: "complete", flushed: 1 });
  });

  test("pending ids stay bounded when governors hold, independently of elapsed admission windows", async () => {
    const state = fixture();
    const source = signal();
    for (
      let index = 0;
      index < VISITED_REPLAY_LIMITS.pendingPerSource;
      index += 1
    ) {
      state.advance(VISITED_REPLAY_LIMITS.windowMs);
      expect(
        state.buffer.offer({
          ...source,
          decisionId: createSafeId<"caseLawDecision">(),
        }),
      ).toBe("buffered");
    }
    state.advance(VISITED_REPLAY_LIMITS.windowMs);
    expect(
      state.buffer.offer({
        ...source,
        decisionId: createSafeId<"caseLawDecision">(),
      }),
    ).toBe("pending-ceiling");
    expect((await state.flush()).flushed).toBe(
      VISITED_REPLAY_LIMITS.pendingPerSource,
    );
    expect(state.queued).toHaveLength(1);
  });

  test("source slots are bounded and expired empty slots are reclaimed", async () => {
    const state = fixture();
    for (let index = 0; index < VISITED_REPLAY_LIMITS.maxSources; index += 1) {
      expect(state.buffer.offer(signal())).toBe("buffered");
    }
    const extra = signal();
    expect(state.buffer.offer(extra)).toBe("source-ceiling");
    expect((await state.flush()).flushed).toBe(
      VISITED_REPLAY_LIMITS.maxSources,
    );
    state.advance(VISITED_REPLAY_LIMITS.windowMs);
    await state.flush();
    expect(state.buffer.offer(extra)).toBe("buffered");
  });

  test("both governors are consulted before every source batch and held hints resume", async () => {
    for (const kind of ["unknown", "stop", "degraded"] as const) {
      const state = fixture();
      state.buffer.offer(signal());
      state.db({ kind, signals: [] });
      expect(await state.flush()).toEqual({
        status: "held",
        reason: "database",
        flushed: 0,
      });
      expect(state.queued).toEqual([]);
      state.db({ kind: "normal", signals: [] });
      expect((await state.flush()).flushed).toBe(1);
    }
    const state = fixture();
    state.buffer.offer(signal());
    state.buffer.offer(signal());
    state.options.enqueueBatch = async (batch) => {
      state.queued.push([...batch]);
      state.latency({
        status: "hold",
        reason: "p95-exceeded",
        p95Ms: 501,
        samples: 20,
      });
    };
    expect(await state.flush()).toEqual({
      status: "held",
      reason: "latency",
      flushed: 1,
    });
    expect(state.queued).toHaveLength(1);
    state.latency({ status: "admit", p95Ms: 10, samples: 20 });
    expect(await state.flush()).toEqual({ status: "complete", flushed: 1 });
    expect(state.queued).toHaveLength(2);
  });

  test("external public corpora never contribute local replay work", async () => {
    const state = fixture();
    state.buffer.offer(signal());
    state.external();
    expect(state.buffer.offer(signal())).toBe("external-corpus");
    expect(await state.flush()).toEqual({
      status: "external-corpus",
      flushed: 0,
    });
    expect(state.queued).toEqual([]);
  });

  test("queue failures preserve hints and duplicate reads during persistence remain deduplicated", async () => {
    const state = fixture();
    const visited = signal();
    state.buffer.offer(visited);
    expect(
      await rejectionOf(
        state.buffer.flush({
          ...state.options,
          enqueueBatch: async () => {
            throw new TypeError("Queue unavailable");
          },
        }),
      ),
    ).toMatchObject({ message: "Queue unavailable" });
    state.options.enqueueBatch = async (batch) => {
      expect(state.buffer.offer(visited)).toBe("deduplicated");
      state.queued.push([...batch]);
    };
    expect((await state.flush()).flushed).toBe(1);
    expect((await state.flush()).flushed).toBe(0);
    expect(state.queued).toEqual([[visited]]);
  });

  test("the time ceiling stops before the next source batch", async () => {
    const state = fixture();
    state.buffer.offer(signal());
    state.buffer.offer(signal());
    state.options.enqueueBatch = async (batch) => {
      state.queued.push([...batch]);
      state.advance(state.options.maxDurationMs);
    };
    expect(await state.flush()).toEqual({ status: "time-limit", flushed: 1 });
    expect(state.queued).toHaveLength(1);
    for (const maxDurationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        await rejectionOf(
          state.buffer.flush({ ...state.options, maxDurationMs }),
        ),
      ).toMatchObject({
        message: "Visited replay flush duration must be finite and positive",
      });
    }
  });
});
