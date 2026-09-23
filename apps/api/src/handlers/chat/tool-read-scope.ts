// Records a thread's data scope while its turn runs.
//
// Every tool result is followed, before it is returned, by a write that folds
// the workspaces the ref registry observed since the turn started into
// `chat_threads.data_workspace_ids`. Anything derived from a tool result during
// the turn (a suggestion saved while the stream is still open, a subagent
// summary, the persisted assistant message) is therefore written after the
// thread's scope already covers the data behind it. The end-of-turn computation
// in `send-message.ts` re-derives everything observed since the turn started,
// in the same transaction as the message, so a scope write that failed
// mid-turn is retried there.
//
// A failed scope write fails a read tool: retrying a read is harmless. A
// mutation has already committed by then, so it keeps its result and the
// failure is captured instead of reported as a retryable tool error.

import { Result } from "better-result";

import {
  CHAT_TOOL_POLICY_KIND,
  copyChatToolPolicy,
  getChatToolPolicy,
} from "@/api/handlers/chat/tools/tool-policy";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";

type WorkspaceId = SafeId<"workspace">;

export type ToolReadScopeRecorder = {
  /**
   * Snapshot the workspaces observed before streaming (prompt pins, prior
   * turns). Only reads after this point widen scope; returns the snapshot.
   */
  startTurn: () => ReadonlySet<WorkspaceId>;
  /** Persist workspaces observed since `startTurn` and not yet recorded. */
  recordObservedReads: () => Promise<Result<void, unknown>>;
};

type CreateToolReadScopeRecorderOptions = {
  accessibleWorkspaceIds: ReadonlySet<string>;
  /** Widens the thread's scope. */
  persist: (
    workspaceIds: readonly WorkspaceId[],
  ) => Promise<Result<unknown, unknown>>;
  refRegistry: Pick<ChatRefRegistry, "getObservedWorkspaceIds">;
};

export const createToolReadScopeRecorder = ({
  accessibleWorkspaceIds,
  persist,
  refRegistry,
}: CreateToolReadScopeRecorderOptions): ToolReadScopeRecorder => {
  let baseline: ReadonlySet<WorkspaceId> | null = null;
  const recorded = new Set<WorkspaceId>();

  return {
    startTurn: () => {
      const snapshot = new Set(refRegistry.getObservedWorkspaceIds());
      baseline = snapshot;
      return snapshot;
    },
    recordObservedReads: async () => {
      if (baseline === null) {
        return Result.ok(undefined);
      }
      const turnBaseline = baseline;
      const additions = refRegistry
        .getObservedWorkspaceIds()
        .filter(
          (observed) =>
            !turnBaseline.has(observed) &&
            !recorded.has(observed) &&
            accessibleWorkspaceIds.has(observed),
        );
      if (additions.length === 0) {
        return Result.ok(undefined);
      }
      const persisted = await persist(additions);
      if (Result.isError(persisted)) {
        return Result.err(persisted.error);
      }
      for (const added of additions) {
        recorded.add(added);
      }
      return Result.ok(undefined);
    },
  };
};

/** Wrap every executable tool so its reads are recorded before it returns. */
export const recordToolReadScope = ({
  recorder,
  tools,
}: {
  recorder: ToolReadScopeRecorder;
  tools: ChatToolMap;
}): ChatToolMap => {
  const wrapped: ChatToolMap = {};
  for (const [name, current] of Object.entries(tools)) {
    if (current === undefined) {
      continue;
    }
    const execute = current.execute;
    if (execute === undefined) {
      wrapped[name] = current;
      continue;
    }
    const committedBeforeScope =
      getChatToolPolicy(current).kind === CHAT_TOOL_POLICY_KIND.mutation;
    const recordingTool = {
      ...current,
      execute: async (input: unknown, context: unknown) => {
        const output: unknown = await execute(input, context);
        const recorded = await recorder.recordObservedReads();
        if (Result.isError(recorded)) {
          const failure = recorded.error;
          if (!committedBeforeScope) {
            throw failure;
          }
          captureError(failure, { source: "chat-tool-read-scope", tool: name });
        }
        return output;
      },
    };
    copyChatToolPolicy(current, recordingTool);
    wrapped[name] = recordingTool;
  }
  return wrapped;
};
