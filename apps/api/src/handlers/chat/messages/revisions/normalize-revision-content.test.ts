import { describe, expect, test } from "bun:test";

import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import { toPersistedChatMessageContentV3 } from "@/api/handlers/chat/chat-message-parts";
import { normalizeRevisionContent } from "@/api/handlers/chat/messages/revisions/normalize-revision-content";

describe("canonical answer snapshots", () => {
  test.each([undefined, {}])(
    "normalization preserves metadata presence and is a fixed point: %j",
    (metadata) => {
      const stored = toPersistedChatMessageContentV3({
        data: [
          { type: "text", content: "Original café 🌍" },
          {
            type: "tool-call",
            id: "call",
            name: "web_search",
            metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
            arguments: "{}",
            state: "complete",
          },
        ],
        ...(metadata === undefined ? {} : { metadata }),
      });
      const normalized = normalizeRevisionContent(stored).content;
      expect(normalized).toEqual(stored);
      expect("metadata" in normalized).toBe("metadata" in stored);
      expect(normalizeRevisionContent(normalized).content).toEqual(normalized);
    },
  );
});
