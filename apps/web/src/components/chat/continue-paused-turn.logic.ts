import { Result } from "better-result";

type ContinuePausedTurnOptions = {
  /** A generated draft is being saved: the chat takes no new turn then. */
  draftSaving?: boolean | undefined;
  ensureAIAvailable: () => Promise<boolean>;
  /** The composer's model and Run on choices still landing. */
  awaitPendingSelection: () => Promise<Result<void, unknown>>;
  continueTurn: () => void | PromiseLike<void>;
};

/**
 * Continue a paused turn under the guards a typed message passes: not while a
 * generated draft is being saved, only once AI is available, and only after
 * the composer's pending choices are stored, so the next turn runs on them.
 * Returns whether the turn was continued.
 */
export const continuePausedTurnWhenReady = async ({
  draftSaving = false,
  ensureAIAvailable,
  awaitPendingSelection,
  continueTurn,
}: ContinuePausedTurnOptions): Promise<boolean> => {
  if (draftSaving || !(await ensureAIAvailable())) {
    return false;
  }
  if (Result.isError(await awaitPendingSelection())) {
    return false;
  }
  await continueTurn();
  return true;
};
