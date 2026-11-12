import type { Result } from "better-result";

import type {
  ChatLocalRunComputerWait,
  ChatLocalRunReadiness,
  ChatRunTarget,
} from "@stll/api-contract/chat-run-target";

/** Opens stella desktop, or brings it forward when it is already open. */
export const DESKTOP_PING_URL = "stella://ping";

/** How long a launch waits for the desktop's runner to connect. */
export const DESKTOP_LAUNCH_TIMEOUT_MS = 45_000;

/** How often a launch reads whether a computer has connected. */
export const DESKTOP_LAUNCH_POLL_MS = 2000;

export type DesktopLaunchOutcome = "connected" | "timed_out";

export type DesktopLaunchState = { type: "idle" } | { type: "opening" };

/** A turn this page holds while stella desktop opens, before it is sent. */
export const OPENING_DESKTOP_WAIT = { status: "opening_desktop" } as const;

/**
 * What a turn for the member's computer waits on: stella desktop opening
 * before this page sends it, or, once sent, the computer as the run reports.
 */
export type ChatComputerWait =
  ChatLocalRunComputerWait | typeof OPENING_DESKTOP_WAIT;

const IDLE = { type: "idle" } as const satisfies DesktopLaunchState;
const OPENING = { type: "opening" } as const satisfies DesktopLaunchState;

/**
 * Whether one of the member's computers is connected now. A read that failed
 * says nothing either way, so the launch keeps waiting until its deadline.
 */
export type ReadComputerConnected = () => Promise<Result<boolean, Error>>;

/** Whether any of the member's computers has its runner connected. */
export const hasConnectedComputer = (readiness: ChatLocalRunReadiness) =>
  readiness.status === "enabled" &&
  readiness.runners.some((runner) => runner.connected);

/**
 * Whether a turn bound for `target` needs stella desktop opened first: it
 * runs on the member's computer, the member may run turns there, and the
 * last read found none of their computers connected. Nothing is claimed
 * before the computers are read.
 */
export const needsDesktopLaunch = (
  target: ChatRunTarget,
  readiness: ChatLocalRunReadiness | undefined,
) =>
  target.kind === "local" &&
  readiness?.status === "enabled" &&
  !hasConnectedComputer(readiness);

type DesktopLaunchOptions = {
  /** Hands the ping link to the operating system. */
  openDesktop: () => void;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
};

export type DesktopLaunch = {
  /**
   * Opens stella desktop now, exactly once, and waits until a computer is
   * connected or the wait times out. Call it only from the member's own
   * gesture (a click, Enter), synchronously: a browser launches the
   * `stella://` link only then. A launch while one waits opens the desktop
   * again for this gesture and restarts the shared wait's deadline; it never
   * starts a second wait.
   */
  launch: (
    readConnected: ReadComputerConnected,
  ) => Promise<DesktopLaunchOutcome>;
  /** The outcome of the launch waiting now; `null` when none is. */
  pending: () => Promise<DesktopLaunchOutcome> | null;
  state: () => DesktopLaunchState;
  subscribe: (listener: () => void) => () => void;
};

/**
 * One browser's launches of stella desktop. A launch never repeats the
 * deep link on its own: it opens it once when called and then only reads
 * whether a computer connected.
 */
export const createDesktopLaunch = ({
  openDesktop,
  now,
  sleep,
  timeoutMs = DESKTOP_LAUNCH_TIMEOUT_MS,
  pollMs = DESKTOP_LAUNCH_POLL_MS,
}: DesktopLaunchOptions): DesktopLaunch => {
  // The wait's deadline is read on every poll, so a later launch extends it.
  let waiting: {
    wait: { deadline: number };
    outcome: Promise<DesktopLaunchOutcome>;
  } | null = null;
  let state: DesktopLaunchState = IDLE;
  const listeners = new Set<() => void>();
  const setState = (next: DesktopLaunchState) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };

  const watch = async (
    wait: { deadline: number },
    readConnected: ReadComputerConnected,
  ): Promise<DesktopLaunchOutcome> => {
    for (;;) {
      const read = await readConnected();
      if (read.isOk() && read.value) {
        return "connected";
      }
      const remaining = wait.deadline - now();
      if (remaining <= 0) {
        return "timed_out";
      }
      await sleep(Math.min(pollMs, remaining));
    }
  };

  return {
    launch: (readConnected) => {
      openDesktop();
      if (waiting !== null) {
        waiting.wait.deadline = now() + timeoutMs;
        return waiting.outcome;
      }
      const wait = { deadline: now() + timeoutMs };
      const outcome = watch(wait, readConnected).then((result) => {
        waiting = null;
        setState(IDLE);
        return result;
      });
      waiting = { wait, outcome };
      setState(OPENING);
      return outcome;
    },
    pending: () => waiting?.outcome ?? null,
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

type HeldForDesktopOptions<Chunk> = {
  /** The launch the send waits on. */
  outcome: Promise<DesktopLaunchOutcome>;
  /** The send's own abort: a Stop while it waits ends it unsent. */
  signal: AbortSignal | undefined;
  /** Told when the hold starts and when it ends. */
  onHold: (held: boolean) => void;
  /** Sends the turn; called once, after the wait. */
  send: () => AsyncIterable<Chunk>;
};

/**
 * A turn for the member's computer held while stella desktop opens, then
 * sent. It is sent whether the computer connected or the wait timed out: the
 * API decides, so a computer still missing gets the same refusal as a turn
 * that was never held. A Stop during the wait sends nothing.
 */
export const heldForDesktop = async function* <Chunk>({
  outcome,
  signal,
  onHold,
  send,
}: HeldForDesktopOptions<Chunk>): AsyncIterable<Chunk> {
  onHold(true);
  const stopped = Promise.withResolvers<"stopped">();
  const onAbort = () => {
    stopped.resolve("stopped");
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const ended =
    signal?.aborted === true
      ? "stopped"
      : await Promise.race([outcome, stopped.promise]);
  signal?.removeEventListener("abort", onAbort);
  onHold(false);
  if (ended === "stopped") {
    return;
  }
  yield* send();
};
