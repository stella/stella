import { readLocalFilesUndo } from "@/api/handlers/chat/turns/local-files-undo";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { RunOwner } from "@/api/lib/desktop-runner/store";

type ChatLocalFilesUndoFixture = {
  control: Pick<DesktopRunnerControl, "readFolderRestore">;
  owner: RunOwner;
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
};

/**
 * Where a turn's undo stands reads the turn, its newest run with whether that
 * run saved a checkpoint, and its newest undo: one row each, however many
 * undos were asked before or events the run stored.
 */
export const chatLocalFilesUndoScalingScenario = {
  name: "chat local files undo",
  definition: readLocalFilesUndo,
  measure: async ({
    control,
    owner,
    threadId,
    turnId,
  }: ChatLocalFilesUndoFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const read = (
        await control.readFolderRestore({ owner, threadId, turnId })
      ).unwrap();
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(read)),
        rows: read === null ? 0 : 1,
      };
    }),
};
