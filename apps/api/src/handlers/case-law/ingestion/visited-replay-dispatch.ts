import { panic } from "better-result";

import { detached } from "@/api/lib/analytics/capture";
import { recordVisitedReplayHintDrop } from "@/api/lib/observability/request-metrics";

import {
  getVisitedReplaySignals,
  VISITED_REPLAY_DROP_REASON,
  VISITED_REPLAY_LIMITS,
  type VisitedReplayCandidate,
  type VisitedReplayDropReason,
} from "./visited-replay";

type VisitDispatchOptions = {
  signals: Pick<ReturnType<typeof getVisitedReplaySignals>, "offer">;
  flush: () => Promise<unknown>;
  track: (work: Promise<void>) => void;
  schedule: (work: () => void, delayMs: number) => void;
  now: () => number;
  recordDrop: (reason: VisitedReplayDropReason) => void;
};
type DispatchState =
  | { status: "idle" }
  | { status: "scheduled" }
  | { status: "running"; next: "clear" | "requested" };

// This coalesces read events; a held flush never schedules another attempt by itself.
const DISPATCH_INTERVAL_MS =
  VISITED_REPLAY_LIMITS.windowMs / VISITED_REPLAY_LIMITS.admissionsPerMinute;

/** Each serving task flushes its own hints, independently of scheduler job claims. */
export const createVisitedReplayDispatch = ({
  signals,
  flush,
  track,
  schedule,
  now,
  recordDrop,
}: VisitDispatchOptions) => {
  let state: DispatchState = { status: "idle" };
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  const requestFlush = () => {
    switch (state.status) {
      case "scheduled":
        return;
      case "running":
        state = { status: "running", next: "requested" };
        return;
      case "idle":
        break;
      default:
        state satisfies never;
        panic("Unknown visited replay dispatcher state");
    }
    state = { status: "scheduled" };
    schedule(
      () => {
        state = { status: "running", next: "clear" };
        lastStartedAt = now();
        const finish = () => {
          if (state.status !== "running") {
            panic("Visited replay flush lost its dispatch state");
          }
          const next = state.next;
          state = { status: "idle" };
          if (next === "requested") {
            requestFlush();
          }
        };
        track(
          Promise.resolve()
            .then(flush)
            .then(() => undefined)
            .finally(finish),
        );
      },
      Math.max(0, lastStartedAt + DISPATCH_INTERVAL_MS - now()),
    );
  };
  return {
    offer: (candidate: VisitedReplayCandidate) => {
      const admission = signals.offer(candidate);
      switch (admission) {
        case "buffered":
        case "deduplicated":
          requestFlush();
          break;
        case VISITED_REPLAY_DROP_REASON.SOURCE_CEILING:
        case VISITED_REPLAY_DROP_REASON.PENDING_CEILING:
        case VISITED_REPLAY_DROP_REASON.RATE_CEILING:
          recordDrop(admission);
          requestFlush();
          break;
        case "external-corpus":
          break;
        default:
          admission satisfies never;
          panic("Unknown visited replay hint admission");
      }
      return admission;
    },
  };
};

let dispatcher: ReturnType<typeof createVisitedReplayDispatch> | undefined;
const getDispatcher = () => {
  dispatcher ??= createVisitedReplayDispatch({
    signals: getVisitedReplaySignals(),
    flush: async () => {
      const { runEnabledVisitedReplayFlush } =
        await import("@/api/scripts/replay-tick-command");
      return await runEnabledVisitedReplayFlush();
    },
    track: (work) => detached(work, "case-law.visited-replay-hints"),
    // A one-shot debounce is driven by read events, never by a polling loop.
    schedule: (work, delayMs) => {
      setTimeout(work, delayMs).unref();
    },
    now: () => performance.now(),
    recordDrop: recordVisitedReplayHintDrop,
  });
  return dispatcher;
};

export const offerVisitedReplayCandidate = (
  candidate: VisitedReplayCandidate,
) => getDispatcher().offer(candidate);
