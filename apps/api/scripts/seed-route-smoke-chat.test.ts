import { describe, expect, test } from "bun:test";

import { chatMessageFromPersisted } from "@/api/handlers/chat/chat-message-parts";
import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { buildRouteSmokeChatRows } from "./seed-route-smoke-chat";

describe("route smoke chat fixtures", () => {
  for (const count of [100, 1000]) {
    test(`every one of ${count} threads has a persisted user message visible to chat history`, () => {
      const organizationId = mintAuthProviderId<"organization">();
      const userId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const { threads, messages } = buildRouteSmokeChatRows({
        count,
        organizationId,
        userId,
        workspaceId,
      });
      const visibleThreadIds = new Set(
        messages.map(({ threadId }) => threadId),
      );
      expect(threads).toHaveLength(count);
      expect(visibleThreadIds).toEqual(new Set(threads.map(({ id }) => id)));
      expect(messages).toHaveLength(count);
      for (const message of messages) {
        expect(message.userId).toBe(userId);
        expect(message.workspaceId).toBe(workspaceId);
        const restored = chatMessageFromPersisted({
          id: message.id,
          role: message.role,
          content: message.content,
        });
        expect(restored.role).toBe("user");
        expect(restored.parts).toEqual([
          { type: "text", content: "Route smoke fixture message." },
        ]);
      }
    });
  }
});
