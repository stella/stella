import { Result } from "better-result";

import type { LocalRunSteeredQueue } from "@/api/handlers/chat/local-run-chunks";

/**
 * The queue of a thread none of whose queued messages is steered: a run's
 * report on a steer written in the composer changes nothing in it.
 */
export const unqueuedSteers: LocalRunSteeredQueue = {
  settle: async () => await Promise.resolve(Result.ok(undefined)),
};
