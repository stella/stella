import type {
  BrowserControlCommand,
  BrowserObservedTab,
} from "@stll/api-contract/browser-control";

import type { LocalBrowserResult } from "./local-result";

/**
 * A browser the tools can run in: the member's Chrome through the stella
 * extension, or the stella browser the holder starts itself. The router
 * (`host-router.ts`) picks one per chat; the tools never know which.
 */

export type BrowserHostRequest = {
  command: BrowserControlCommand;
  /** The chat the agent runs in; each chat has tabs of its own. */
  controllerId: string;
  observedTab: BrowserObservedTab | null;
  toolCallId: string;
  /** The run; per-turn budgets count by it. */
  turnId: string;
};

/** Which command to stop: the chat's controller and its run. */
export type BrowserHostCancel = { controllerId: string; turnId: string };

export type BrowserHost = {
  /** Sends one command and waits for its result, a timeout, or `signal`. */
  request: (
    request: BrowserHostRequest,
    signal: AbortSignal,
  ) => Promise<LocalBrowserResult>;
  /** Stops the run's queued or running command. */
  cancel: (run: BrowserHostCancel) => void;
  /** The chat is gone: its tabs close, where the host owns them. */
  releaseChat: (controllerId: string) => void;
  /**
   * Whether steps that change a page (click, type, keys, options, going
   * back, switching tabs) run here; reading always does.
   */
  acts: boolean;
};
