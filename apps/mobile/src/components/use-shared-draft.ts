import { useEffect, useRef } from "react";

import { Result } from "better-result";

import { discardShare, readShare } from "@/native/share-inbox";
import type { PickedFile } from "@/state/chat-attachments";
import { sharedDraftText, sharedPickedFiles } from "@/state/shared-items";

/**
 * Starts a conversation's message with what another app shared, once: its
 * links and text into the draft, its files as attachments. The share's
 * folder is deleted once the files are read into the message, which holds
 * them from then on.
 */
export const useSharedDraft = ({
  addFiles,
  onFailed,
  onText,
  shareId,
}: {
  addFiles: (files: readonly PickedFile[]) => Promise<void>;
  onFailed: () => void;
  onText: (text: string) => void;
  shareId: string | undefined;
}) => {
  const taken = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (shareId === undefined || taken.current === shareId) {
      return;
    }
    taken.current = shareId;
    void (async () => {
      const share = await readShare(shareId);
      if (Result.isError(share)) {
        onFailed();
        return;
      }
      const text = sharedDraftText(share.value);
      if (text !== "") {
        onText(text);
      }
      await addFiles(sharedPickedFiles(share.value));
      // Best effort: what is left is deleted within the hour by the next
      // share or the next share screen.
      discardShare(shareId).unwrapOr(undefined);
    })();
  }, [addFiles, onFailed, onText, shareId]);
};
