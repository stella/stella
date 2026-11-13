import { describe, expect, test } from "bun:test";

import type { HarnessLiveSession } from "./adapter";
import { harnessSessionId } from "./events";
import {
  BackgroundTasks,
  keepLiveSession,
  type KeptSession,
} from "./live-session";
import { type HarnessExit, HarnessTurnLifecycle } from "./turn-lifecycle";

/**
 * A harness process that records what was asked of it and exits once its
 * input closes or it is killed, as a CLI does.
 */
const fakeProcess = () => {
  const { promise: exited, resolve } = Promise.withResolvers<HarnessExit>();
  const asked: string[] = [];
  return {
    asked,
    exited,
    closeInput: () => {
      asked.push("closeInput");
      resolve({ exitCode: 0, signal: null });
    },
    kill: async () => {
      asked.push("kill");
      resolve({ exitCode: null, signal: "SIGTERM" });
      return await exited;
    },
    /** The process exits on its own, a crash say. */
    crash: () => {
      resolve({ exitCode: 1, signal: null });
    },
  };
};

const SESSION = harnessSessionId("session-1");

const kept = (count: number) => {
  const process = fakeProcess();
  const background = new BackgroundTasks();
  background.set(count);
  const errors: unknown[] = [];
  const session = keepLiveSession({
    harness: "codex",
    sessionId: SESSION,
    process,
    background,
    gracePeriodMs: 50,
    stopBackground: async () => {
      process.asked.push("stopBackground");
    },
    detached: (operation) => {
      Promise.resolve(operation).catch((error: unknown) => {
        errors.push(error);
      });
    },
  });
  const counts: number[] = [];
  session.session.watch((value) => {
    counts.push(value);
  });
  return { process, background, session, counts, errors };
};

describe("a harness process kept for its background work", () => {
  test("reports each change of its work and ends once none is left", async () => {
    const { process, background, session, counts } = kept(2);
    expect(session.session.backgroundTasks).toBe(2);
    background.set(1);
    background.set(0);
    await session.session.ended;
    expect(counts).toEqual([1, 0]);
    // The work is stopped through the harness before its process closes.
    expect(process.asked).toEqual(["stopBackground", "closeInput"]);
    expect(session.session.backgroundTasks).toBe(0);
  });

  test("ending it stops its work first, and every call is the same ending", async () => {
    const { process, session, counts } = kept(1);
    await Promise.all([session.session.end(), session.session.end()]);
    expect(process.asked).toEqual(["stopBackground", "closeInput"]);
    expect(counts).toEqual([0]);
    expect(session.take()).toBe(false);
  });

  test("a process that exits by itself ends the session", async () => {
    const { process, session, counts } = kept(1);
    process.crash();
    await session.session.ended;
    expect(counts).toEqual([0]);
    expect(session.session.backgroundTasks).toBe(0);
    expect(session.take()).toBe(false);
  });

  test("a process that does not close in time is killed", async () => {
    const process = fakeProcess();
    const background = new BackgroundTasks();
    background.set(1);
    const stubborn = { ...process, closeInput: () => undefined };
    const session = keepLiveSession({
      harness: "claude-code",
      sessionId: SESSION,
      process: stubborn,
      background,
      gracePeriodMs: 10,
      // A harness that never answers does not hold the ending up.
      stopBackground: async () => {
        await Promise.withResolvers<undefined>().promise;
      },
      detached: () => undefined,
    });
    await session.session.end();
    expect(process.asked).toEqual(["kill"]);
  });

  test("the next turn takes it: it stops reporting and no longer ends by itself", async () => {
    const { process, background, session, counts } = kept(1);
    expect(session.take()).toBe(true);
    expect(session.take()).toBe(false);
    background.set(0);
    background.set(3);
    expect(counts).toEqual([]);
    expect(process.asked).toEqual([]);
    process.crash();
    await session.session.ended;
    expect(counts).toEqual([]);
  });
});

/** A lifecycle whose adapter keeps the process with `session`, if any. */
const lifecycleKeeping = (session: KeptSession | null) => {
  const process = fakeProcess();
  const lifecycle = new HarnessTurnLifecycle<ReturnType<typeof fakeProcess>>({
    gracePeriodMs: 50,
    detached: () => undefined,
    name: "test-turn",
    background: {
      keep: async () => session?.session ?? null,
      stopBackground: async () => {
        process.asked.push("stopBackground");
      },
    },
  });
  lifecycle.attach(process);
  const turn = lifecycle.turn({
    respond: () => {
      throw new Error("no interaction in this test");
    },
    interrupt: async () => {
      await Promise.resolve();
    },
  });
  return { process, lifecycle, turn };
};

const drain = async (events: AsyncIterable<unknown>) => {
  for await (const _event of events) {
    // Only the end matters.
  }
};

describe("a turn's end", () => {
  test("hands a completed turn's kept process to the caller once", async () => {
    const live = kept(1).session;
    const { process, lifecycle, turn } = lifecycleKeeping(live);
    lifecycle.emit({ type: "turn.completed", usage: null });
    await drain(turn.events);
    const released: HarnessLiveSession | null = await turn.release();
    expect(released).toBe(live.session);
    expect(await turn.release()).toBeNull();
    // The caller owns it now: disposing the turn leaves it running.
    await turn.dispose();
    expect(live.session.backgroundTasks).toBe(1);
    expect(process.asked).toEqual([]);
  });

  test("a kept process nobody released is ended with the turn", async () => {
    const live = kept(1);
    const { lifecycle, turn } = lifecycleKeeping(live.session);
    lifecycle.emit({ type: "turn.completed", usage: null });
    await turn.dispose();
    expect(live.process.asked).toEqual(["stopBackground", "closeInput"]);
  });

  test("an interrupted turn keeps nothing: its work is stopped and the process closed", async () => {
    const live = kept(1);
    const { process, lifecycle, turn } = lifecycleKeeping(live.session);
    lifecycle.emit({ type: "turn.interrupted" });
    expect(await turn.release()).toBeNull();
    expect(process.asked).toEqual(["stopBackground", "closeInput"]);
  });

  test("a failed turn keeps nothing", async () => {
    const live = kept(1);
    const { process, lifecycle, turn } = lifecycleKeeping(live.session);
    lifecycle.emit({
      type: "turn.failed",
      failure: { type: "protocol_violation", message: "Broken." },
    });
    expect(await turn.release()).toBeNull();
    expect(process.asked).toEqual(["stopBackground", "closeInput"]);
  });

  test("a completed turn with nothing in the background closes as before", async () => {
    const { process, lifecycle, turn } = lifecycleKeeping(null);
    lifecycle.emit({ type: "turn.completed", usage: null });
    expect(await turn.release()).toBeNull();
    expect(process.asked).toEqual(["stopBackground", "closeInput"]);
  });

  test("a turn released before it ended is interrupted and keeps nothing", async () => {
    const live = kept(1);
    const { process, turn } = lifecycleKeeping(live.session);
    expect(await turn.release()).toBeNull();
    expect(process.asked).toEqual(["stopBackground", "closeInput"]);
  });
});
