import type { AgentHarness } from "@stll/api-contract/agent-harness";

import type { HarnessLiveSession } from "./adapter";
import type { HarnessSessionId } from "./events";
import {
  type Detached,
  type HarnessExit,
  settlesWithin,
} from "./turn-lifecycle";

/**
 * A harness process kept between the turns of one chat while work its agent
 * started in the background still runs (`HarnessLiveSession`). Both harnesses
 * keep that work inside the process that started it: Codex's background
 * terminals and Claude Code's background shells belong to the running CLI
 * and end with it, so the next turn sees them only in the same process.
 */

/** What a kept session needs of the harness process. */
type LiveProcess = {
  /** Settles when the process, and everything it started, is gone. */
  readonly exited: Promise<HarnessExit>;
  closeInput: () => void;
  kill: () => Promise<HarnessExit>;
};

/**
 * How many tasks a harness process runs in the background, as the harness
 * reports them, across every turn it hosts. Changes go to the session that
 * keeps the process between turns; while a turn holds it they go nowhere,
 * and the turn's end reads the count afresh.
 */
export class BackgroundTasks {
  private value = 0;
  private listener: ((count: number) => void) | null = null;

  get count(): number {
    return this.value;
  }

  set(count: number) {
    if (count === this.value) {
      return;
    }
    this.value = count;
    this.listener?.(count);
  }

  /** Where changes go from now on; `null` while a turn holds the process. */
  follow(listener: ((count: number) => void) | null) {
    this.listener = listener;
  }
}

/** Ask the process to exit cleanly, then end it and its tree. */
const closeProcess = async (process: LiveProcess, gracePeriodMs: number) => {
  process.closeInput();
  if (!(await settlesWithin(process.exited, gracePeriodMs))) {
    await process.kill();
  }
};

type KeepLiveSessionOptions = {
  harness: AgentHarness;
  sessionId: HarnessSessionId;
  process: LiveProcess;
  background: BackgroundTasks;
  /** How long ending the background tasks and the process each may take. */
  gracePeriodMs: number;
  /**
   * Ends the harness's background tasks through its own protocol, which
   * reaches what the process tree cannot (a task the harness started in a
   * session of its own). Bounded by the grace period; the tree ends anyway.
   */
  stopBackground: () => Promise<void>;
  detached: Detached;
};

export type KeptSession = {
  readonly session: HarnessLiveSession;
  /**
   * The next turn takes the process: the session stops reporting and ending
   * by itself, and the turn owns the process from now on. `false` once the
   * session is ending or ended; the process is then not the turn's to use.
   */
  take: () => boolean;
};

/** Keep a process whose completed turn left work in the background. */
export const keepLiveSession = ({
  harness,
  sessionId,
  process,
  background,
  gracePeriodMs,
  stopBackground,
  detached,
}: KeepLiveSessionOptions): KeptSession => {
  const listeners: ((count: number) => void)[] = [];
  const state: {
    taken: boolean;
    exited: boolean;
    ending: Promise<void> | null;
  } = { taken: false, exited: false, ending: null };
  const notify = (count: number) => {
    for (const listener of listeners) {
      listener(count);
    }
  };
  const end = async () => {
    state.ending ??= (async () => {
      background.follow(null);
      await settlesWithin(stopBackground(), gracePeriodMs);
      await closeProcess(process, gracePeriodMs);
    })();
    await state.ending;
  };
  const ended = (async () => {
    await process.exited;
    state.exited = true;
    background.follow(null);
    if (!state.taken) {
      notify(0);
    }
  })();
  background.follow((count) => {
    if (state.taken || state.ending !== null) {
      return;
    }
    notify(count);
    if (count === 0) {
      // Nothing left in the background: the process is not kept for that.
      detached(end(), "live-session.end");
    }
  });
  const session: HarnessLiveSession = {
    harness,
    sessionId,
    get backgroundTasks() {
      return state.exited || state.ending !== null ? 0 : background.count;
    },
    watch: (listener) => {
      listeners.push(listener);
    },
    ended,
    end,
  };
  return {
    session,
    take: () => {
      if (state.taken || state.exited || state.ending !== null) {
        return false;
      }
      state.taken = true;
      background.follow(null);
      return true;
    },
  };
};
