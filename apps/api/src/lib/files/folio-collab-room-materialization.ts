import { Result } from "better-result";
import * as Y from "yjs";

import { canonicalSnapshotId } from "@stll/folio-core/canonical/canonicalRoomBase";
import {
  type CanonicalYjsRoomError,
  readCanonicalYjsJournal,
} from "@stll/folio-core/controller/canonicalYjsRoom";
import type { FolioRoomJournalError } from "@stll/folio-core/server";

import { replayRoomJournalOverScannedDocx } from "@/api/lib/file-scan/document-parsers";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";

/**
 * A collaboration room saved over the scanned document it was seeded from:
 * the journal its authority sequenced, read from the stored Yjs state and
 * replayed over that document. A room seeded from other bytes, or whose
 * journal does not replay, is refused.
 */
export const materializeRoomOverScannedDocx = async ({
  source,
  yjsUpdate,
}: {
  source: ScannedFile;
  yjsUpdate: Uint8Array;
}): Promise<
  Result<ArrayBuffer, CanonicalYjsRoomError | FolioRoomJournalError>
> => {
  const room = new Y.Doc();
  Y.applyUpdate(room, yjsUpdate);
  const journal = readCanonicalYjsJournal({
    doc: room,
    snapshot: await canonicalSnapshotId(source.bytes),
  });
  room.destroy();
  if (Result.isError(journal)) {
    return Result.err(journal.error);
  }
  return await replayRoomJournalOverScannedDocx({
    source,
    journal: journal.value,
  });
};
