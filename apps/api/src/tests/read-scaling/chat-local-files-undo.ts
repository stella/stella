import { readLocalFilesUndo } from "@/api/handlers/chat/messages/local-files-undo";
import type { SafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import type { DesktopRunnerControl } from "@/api/lib/desktop-runner/control";
import type { RunOwner } from "@/api/lib/desktop-runner/store";

type ChatLocalFilesUndoFixture = {
  control: Pick<DesktopRunnerControl, "readFolderRestore">;
  owner: RunOwner;
  threadId: SafeId<"chatThread">;
  messageId: SafeId<"chatMessage">;
};

/**
 * What an edit from a message does on the computer reads the message's turn,
 * the first run from it on with whether it saved a checkpoint, a bounded
 * count of later checkpoints and the checkpoint's newest undo: one row each,
 * however many undos were asked before or events the runs stored.
 */
export const chatLocalFilesUndoScalingScenario = {
  name: "chat local files undo",
  definition: readLocalFilesUndo,
  measure: async ({
    control,
    owner,
    threadId,
    messageId,
  }: ChatLocalFilesUndoFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const read = (
        await control.readFolderRestore({ owner, threadId, messageId })
      ).unwrap();
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(read)),
        rows: read === null ? 0 : 1,
      };
    }),
};
