import { stableStringify } from "@stll/stable-stringify";

import { toJsonValue } from "@/api/lib/json-value";

/**
 * Per-turn memo of tool calls that failed with a `server-defect`
 * `ChatToolError`. The orchestrators consult it before dispatch and refuse the
 * identical tool+args mechanically, so "do not retry this call" is enforced in
 * code rather than left to the model's reading of the error prose (the blind
 * five-retry loops that motivated this were exactly that contract failing).
 *
 * Created once per chat turn in `send-message` and threaded to every tool
 * factory alongside `ChatRefRegistry`, whose lifetime it shares: a defect is a
 * property of this deployment's code, but scoping the memo to the turn keeps
 * it deploy-safe (a fixed defect is retryable next turn) and state-free.
 */
export type ChatToolDefectMemo = {
  isKnownDefect: (toolName: string, args: unknown) => boolean;
  recordDefect: (toolName: string, args: unknown) => void;
};

// Tool arguments reach the memo as `unknown` from the model runtime, which
// decoded them from JSON; `toJsonValue` is where that becomes a fact the
// fingerprint's input contract can rely on.
const keyOf = (toolName: string, args: unknown): string =>
  `${toolName}:${stableStringify(toJsonValue(args))}`;

export const createChatToolDefectMemo = (): ChatToolDefectMemo => {
  const defects = new Set<string>();
  return {
    isKnownDefect: (toolName, args) => defects.has(keyOf(toolName, args)),
    recordDefect: (toolName, args) => {
      defects.add(keyOf(toolName, args));
    },
  };
};

/** The refusal surfaced instead of re-executing a known-defective call. */
export const knownDefectRefusalMessage = (toolName: string): string =>
  `This exact ${toolName} call already failed with a server-side defect in ` +
  "this turn, so it was refused without re-executing. Change the input, use " +
  "a different tool, or report the limitation to the user.";
