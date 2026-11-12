import { Result, TaggedError } from "better-result";

import type { ReasoningEffort } from "@stll/ai-catalog";
import type { ChatRunTarget } from "@stll/api-contract/chat-run-target";

/** A composer's whole choice: its model and effort, and where turns run. */
export type ComposerChoice = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  runTarget: ChatRunTarget;
};

/** A pick queued behind a write that failed, which reset the choice. */
export class ComposerChoiceSuperseded extends TaggedError(
  "ComposerChoiceSuperseded",
)<{ message: string }> {}

type ComposerChoiceDeps<E> = {
  /** Stores one whole choice on the server. */
  write: (choice: ComposerChoice) => Promise<Result<void, E>>;
  /** A write was stored: the stored choice is now `choice`. */
  stored: (choice: ComposerChoice) => void;
  /** A write failed: read the stored choice from the server again. */
  refetch: () => Promise<void>;
  /** A write failed, after the stored choice was read again. */
  failed: (error: E) => void;
};

/**
 * The one owner of what a composer's member chose. A pick sets the desired
 * choice at once, composed on the previous desired one, or on the stored
 * one when nothing is pending, so the menus and a send read what the member
 * picked last. Writes go out one at a time, each carrying the whole choice,
 * and every one that is stored is applied to the stored choice in order.
 * A failed write drops the picks queued behind it, reads the stored choice
 * from the server again and shows that, so the composer never shows a
 * choice the server does not hold.
 */
export const createComposerChoice = <E>(deps: ComposerChoiceDeps<E>) => {
  /** The member's newest pick not yet stored; `null` shows the stored one. */
  let desired: ComposerChoice | null = null;
  let tail: Promise<Result<void, E | ComposerChoiceSuperseded>> =
    Promise.resolve(Result.ok(undefined));
  /** Bumped by a failed write; a pick queued before it is dropped. */
  let epoch = 0;
  /** Picks made so far, to tell whether one came after a reset began. */
  let picks = 0;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  const setDesired = (next: ComposerChoice | null) => {
    desired = next;
    changed();
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The desired choice, or `null` while it is the stored one. */
    desired: () => desired,
    /** Pick part of the choice on top of `stored`, the stored choice now. */
    pick: (stored: ComposerChoice, change: Partial<ComposerChoice>) => {
      const next = { ...(desired ?? stored), ...change };
      picks += 1;
      setDesired(next);
      const queuedIn = epoch;
      const previous = tail;
      tail = (async (): Promise<Result<void, E | ComposerChoiceSuperseded>> => {
        // Only the order matters here: an earlier write reports its own
        // outcome, and a failure moves the epoch on.
        await previous.then(() => null);
        if (epoch !== queuedIn) {
          return Result.err(
            new ComposerChoiceSuperseded({
              message: "An earlier choice failed and the stored one is shown",
            }),
          );
        }
        const written = await deps.write(next);
        if (Result.isError(written)) {
          epoch += 1;
          const resetAt = picks;
          await deps.refetch();
          // A pick made while the stored choice was read again stands.
          if (picks === resetAt) {
            setDesired(null);
          }
          deps.failed(written.error);
          return written;
        }
        deps.stored(next);
        if (desired === next) {
          setDesired(null);
        }
        return written;
      })();
    },
    /** Resolves once every pick so far was stored or failed. */
    settled: async () => await tail,
  };
};

export type ComposerChoiceOwner<E> = ReturnType<typeof createComposerChoice<E>>;
