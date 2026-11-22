import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { ApiRequestError } from "@/state/api-request";

import { RECOVERED_OFFER_MS } from "./dictation-kept";
import type { KeptDictation } from "./dictation-kept";
import { createKeptDictations } from "./kept-dictations";
import type { KeptFiles, RetryOutcome } from "./kept-dictations";

const ACCOUNT = { serverUrl: "https://stella.example.com", userId: "user-1" };

const SETUP = {
  field: "chat",
  matterId: null,
  modelId: null,
  modelClass: null,
  locale: "en",
  cleanup: false,
  style: "polished",
  translateTo: null,
} as const;

/** The phone's files, in memory: each dictation's description and its recordings. */
const memoryFiles = (initial: readonly KeptDictation[] = []) => {
  const described = new Map(initial.map((kept) => [kept.id, kept]));
  const recordings = new Map<string, Set<string>>();
  const writes = { fail: false };
  const files: KeptFiles = {
    list: async () => await Promise.resolve(Result.ok([...described.values()])),
    keep: (kept, moved) => {
      described.set(kept.id, kept);
      recordings.set(kept.id, new Set(moved.map(({ file }) => file)));
      return true;
    },
    update: (kept) => {
      if (writes.fail) {
        return false;
      }
      described.set(kept.id, kept);
      return true;
    },
    removeRecording: (id, file) => recordings.get(id)?.delete(file) ?? false,
    forget: (id) => {
      recordings.delete(id);
      return described.delete(id);
    },
  };
  return { described, recordings, files, writes };
};

/** A clock and timers the test moves by hand. */
const manualTime = () => {
  let now = 1_000_000;
  const timers = new Set<{ at: number; run: () => void }>();
  return {
    now: () => now,
    later: (run: () => void, ms: number) => {
      const timer = { at: now + ms, run };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    /** Moves the clock on and runs what came due. */
    advance: (ms: number) => {
      now += ms;
      for (const timer of [...timers]) {
        if (timer.at <= now) {
          timers.delete(timer);
          timer.run();
        }
      }
    },
    pending: () => timers.size,
  };
};

const setUp = ({
  initial = [],
  outcomes,
}: {
  initial?: readonly KeptDictation[];
  outcomes: RetryOutcome[];
}) => {
  const disk = memoryFiles(initial);
  const time = manualTime();
  const retried: string[] = [];
  let ids = 0;
  const store = createKeptDictations({
    account: ACCOUNT,
    files: disk.files,
    retry: async (kept) => {
      retried.push(kept.id);
      return outcomes.shift() ?? { type: "silent" };
    },
    now: time.now,
    later: time.later,
    newId: () => {
      ids += 1;
      return `kept-${ids}`;
    },
  });
  return { disk, time, retried, store };
};

const offline = (): RetryOutcome => ({
  type: "failed",
  pieces: [{ type: "audio", file: "0.m4a" }],
  error: new ApiRequestError({ message: "synthetic offline" }),
});

describe("kept dictations", () => {
  test("a failed dictation is kept and goes to its open field once transcribed", async () => {
    const { disk, store, time } = setUp({
      outcomes: [
        {
          type: "transcribed",
          dictated: { text: "Call the court.", names: [] },
        },
      ],
    });
    const delivered: string[] = [];
    store.own("field-1", ({ text }) => {
      delivered.push(text);
      return true;
    });
    expect(
      store.keep({
        owner: "field-1",
        setup: SETUP,
        pieces: [{ type: "audio", uri: "file:///tmp/piece.m4a" }],
        refused: false,
        refusedFor: null,
      }),
    ).toBe(true);
    expect(disk.recordings.get("kept-1")).toEqual(new Set(["0.m4a"]));
    expect(store.views()).toEqual([
      { id: "kept-1", field: "chat", owner: "field-1", status: "waiting" },
    ]);

    time.advance(30_000);
    // The retry the timer started.
    await store.retryWaiting();
    expect(delivered).toEqual(["Call the court."]);
    expect(store.views()).toEqual([]);
    expect(disk.described.size).toBe(0);
  });

  test("a closed field's text is offered for pasting for ten minutes", async () => {
    const { disk, store, time } = setUp({
      outcomes: [
        {
          type: "transcribed",
          dictated: { text: "Recovered words.", names: [] },
        },
      ],
    });
    const release = store.own("field-1", () => true);
    store.keep({
      owner: "field-1",
      setup: SETUP,
      pieces: [{ type: "audio", uri: "file:///tmp/piece.m4a" }],
      refused: false,
      refusedFor: null,
    });
    release();
    await store.retryWaiting();

    expect(store.views()).toEqual([
      { id: "kept-1", field: "chat", owner: null, status: "recovered" },
    ]);
    expect(disk.recordings.get("kept-1")).toEqual(new Set());
    time.advance(RECOVERED_OFFER_MS);
    expect(store.views()).toEqual([]);
    expect(disk.described.size).toBe(0);
  });

  test("a recovered text is taken once", async () => {
    const { store } = setUp({
      outcomes: [
        { type: "transcribed", dictated: { text: "Once.", names: [] } },
      ],
    });
    store.keep({
      owner: "gone",
      setup: SETUP,
      pieces: [{ type: "audio", uri: "file:///tmp/piece.m4a" }],
      refused: false,
      refusedFor: null,
    });
    await store.retryWaiting();
    expect(store.take("kept-1")?.text).toBe("Once.");
    expect(store.take("kept-1")).toBeUndefined();
  });

  test("offline, it waits longer after each try; a refusal waits for the person", async () => {
    const { retried, store, time } = setUp({
      outcomes: [
        offline(),
        {
          type: "failed",
          pieces: [{ type: "audio", file: "0.m4a" }],
          error: new ApiRequestError({ message: "synthetic", status: 400 }),
        },
        { type: "transcribed", dictated: { text: "At last.", names: [] } },
      ],
    });
    const delivered: string[] = [];
    store.own("field-1", ({ text }) => {
      delivered.push(text);
      return true;
    });
    store.keep({
      owner: "field-1",
      setup: SETUP,
      pieces: [{ type: "audio", uri: "file:///tmp/piece.m4a" }],
      refused: false,
      refusedFor: null,
    });
    time.advance(30_000);
    // The retry the timer started.
    await store.retryWaiting();
    expect(retried).toEqual(["kept-1"]);
    // The second try waits a minute, not half of one.
    time.advance(30_000);
    expect(retried).toHaveLength(1);
    time.advance(30_000);
    // The retry the timer started.
    await store.retryWaiting();
    expect(retried).toHaveLength(2);
    expect(store.views().at(0)?.status).toBe("needs-person");
    expect(time.pending()).toBe(0);

    await store.retryWaiting();
    expect(retried).toHaveLength(2);
    await store.retry(["kept-1"]);
    expect(delivered).toEqual(["At last."]);
  });

  test("a retry keeps what it transcribed and deletes those recordings", async () => {
    const { disk, store } = setUp({
      outcomes: [
        {
          type: "failed",
          pieces: [
            { type: "text", text: "First." },
            { type: "audio", file: "1.m4a" },
          ],
          error: new ApiRequestError({ message: "synthetic", status: 503 }),
        },
      ],
    });
    store.keep({
      owner: "field-1",
      setup: SETUP,
      pieces: [
        { type: "audio", uri: "file:///tmp/a.m4a" },
        { type: "audio", uri: "file:///tmp/b.m4a" },
      ],
      refused: false,
      refusedFor: null,
    });
    await store.retryWaiting();
    expect(disk.recordings.get("kept-1")).toEqual(new Set(["1.m4a"]));
    expect(disk.described.get("kept-1")?.state).toEqual({
      type: "waiting",
      refused: false,
      refusedFor: null,
      pieces: [
        { type: "text", text: "First." },
        { type: "audio", file: "1.m4a" },
      ],
    });
  });

  test("discarding deletes the recordings, even while a retry runs", async () => {
    const { disk, store } = setUp({
      outcomes: [
        { type: "transcribed", dictated: { text: "Too late.", names: [] } },
      ],
    });
    const delivered: string[] = [];
    store.own("field-1", ({ text }) => {
      delivered.push(text);
      return true;
    });
    store.keep({
      owner: "field-1",
      setup: SETUP,
      pieces: [{ type: "audio", uri: "file:///tmp/piece.m4a" }],
      refused: false,
      refusedFor: null,
    });
    const retrying = store.retryWaiting();
    store.discard(["kept-1"]);
    await retrying;
    expect(delivered).toEqual([]);
    expect(store.views()).toEqual([]);
    expect(disk.described.size).toBe(0);
  });

  test("a field closed while its dictation was transcribed gets the offer instead", () => {
    const { store } = setUp({ outcomes: [] });
    store.deliver({
      owner: "closed",
      setup: SETUP,
      dictated: { text: "Not lost.", names: ["Novák"] },
    });
    expect(store.views()).toEqual([
      { id: "kept-1", field: "chat", owner: null, status: "recovered" },
    ]);
    expect(store.take("kept-1")).toEqual({
      text: "Not lost.",
      names: ["Novák"],
    });
  });

  test("an earlier run's dictations load for their own account only, and expired offers go", async () => {
    const waiting: KeptDictation = {
      id: "earlier",
      ...ACCOUNT,
      ...SETUP,
      keptAt: 1,
      state: {
        type: "waiting",
        refused: false,
        refusedFor: null,
        pieces: [{ type: "audio", file: "0.m4a" }],
      },
    };
    const otherAccount: KeptDictation = {
      ...waiting,
      id: "other",
      userId: "user-2",
    };
    const expired: KeptDictation = {
      ...waiting,
      id: "expired",
      state: { type: "recovered", text: "Old.", names: [], recoveredAt: 0 },
    };
    const { disk, retried, store } = setUp({
      initial: [waiting, otherAccount, expired],
      outcomes: [offline()],
    });
    expect(await store.load()).toBe(true);
    await store.retryWaiting();
    expect(retried).toEqual(["earlier"]);
    expect(store.views().map(({ id }) => id)).toEqual(["earlier"]);
    expect([...disk.described.keys()]).toEqual(["earlier", "other"]);
  });

  test("recordings stay while the text that replaces them cannot be written", async () => {
    const { disk, store } = setUp({
      outcomes: [
        { type: "transcribed", dictated: { text: "Unsaved.", names: [] } },
      ],
    });
    store.keep({
      owner: "closed",
      setup: SETUP,
      pieces: [{ type: "audio", uri: "file:///tmp/piece.m4a" }],
      refused: false,
      refusedFor: null,
    });
    disk.writes.fail = true;
    await store.retryWaiting();
    expect(disk.recordings.get("kept-1")).toEqual(new Set(["0.m4a"]));
  });

  test("after sign-out nothing more is kept or offered", () => {
    const { disk, store } = setUp({ outcomes: [] });
    store.stop();
    expect(
      store.keep({
        owner: "field-1",
        setup: SETUP,
        pieces: [{ type: "audio", uri: "file:///tmp/piece.m4a" }],
        refused: false,
        refusedFor: null,
      }),
    ).toBe(false);
    store.deliver({
      owner: "closed",
      setup: SETUP,
      dictated: { text: "Late.", names: [] },
    });
    expect(disk.described.size).toBe(0);
  });

  test("a field that takes no text now, as while sending, gets the offer instead", async () => {
    const { store } = setUp({
      outcomes: [
        {
          type: "transcribed",
          dictated: { text: "Not into the sent draft.", names: [] },
        },
      ],
    });
    store.own("field-1", () => false);
    store.keep({
      owner: "field-1",
      setup: SETUP,
      pieces: [{ type: "audio", uri: "file:///tmp/piece.m4a" }],
      refused: false,
      refusedFor: null,
    });
    await store.retryWaiting();
    expect(store.views()).toEqual([
      { id: "kept-1", field: "chat", owner: null, status: "recovered" },
    ]);
  });

  test("a refusal waits for the person after a restart too", async () => {
    const refused: KeptDictation = {
      id: "refused",
      ...ACCOUNT,
      ...SETUP,
      keptAt: 1,
      state: {
        type: "waiting",
        refused: true,
        refusedFor: null,
        pieces: [{ type: "audio", file: "0.m4a" }],
      },
    };
    const { retried, store } = setUp({ initial: [refused], outcomes: [] });
    await store.load();
    await store.retryWaiting();
    expect(retried).toEqual([]);
    expect(store.views().at(0)?.status).toBe("needs-person");
  });

  test("a dictation refused for its withdrawn model asks for another model", async () => {
    const { disk, store } = setUp({
      outcomes: [
        {
          type: "failed",
          pieces: [{ type: "audio", file: "0.m4a" }],
          error: new ApiRequestError({
            message: "synthetic",
            status: 503,
            code: "transcription_model_unavailable",
          }),
        },
      ],
    });
    store.keep({
      owner: "field-1",
      setup: SETUP,
      pieces: [{ type: "audio", uri: "file:///tmp/piece.m4a" }],
      refused: false,
      refusedFor: null,
    });
    await store.retryWaiting();
    expect(store.views().at(0)?.status).toBe("needs-model");
    expect(disk.described.get("kept-1")?.state).toMatchObject({
      refused: true,
      refusedFor: "model",
    });
  });
});
