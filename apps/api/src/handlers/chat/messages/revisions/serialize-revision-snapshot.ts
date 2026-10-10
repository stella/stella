import type { PersistedChatMessageContent } from "@/api/handlers/chat/types";

type RevisionSnapshot<Version> = {
  version: Version;
  data: unknown[];
  metadata?: unknown;
};

// Persistence proofs belong to the server; snapshots expose only stored JSON.
export const serializeRevisionSnapshot = <
  Version extends PersistedChatMessageContent["version"],
>(
  content: RevisionSnapshot<Version>,
): RevisionSnapshot<Version> => ({
  version: content.version,
  data: content.data,
  ...(content.metadata === undefined ? {} : { metadata: content.metadata }),
});
