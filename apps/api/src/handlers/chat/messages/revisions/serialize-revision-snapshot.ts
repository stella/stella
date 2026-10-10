import { panic } from "better-result";

import type { PersistedChatMessageContent } from "@/api/handlers/chat/types";

type RevisionSnapshot = {
  version: PersistedChatMessageContent["version"];
  data: unknown[];
  metadata?: unknown;
};

// Persistence proofs belong to the server; snapshots expose only stored JSON.
export const serializeRevisionSnapshot = (
  content: RevisionSnapshot,
): RevisionSnapshot => {
  if (content.version !== 3) {
    panic("Stored chat content requires the v3 data backfill");
  }
  return {
    version: content.version,
    data: content.data,
    ...(content.metadata === undefined ? {} : { metadata: content.metadata }),
  };
};
