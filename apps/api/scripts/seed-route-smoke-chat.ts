import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";

type BuildRouteSmokeChatRowsOptions = {
  count: number;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export const buildRouteSmokeChatRows = ({
  count,
  organizationId,
  userId,
  workspaceId,
}: BuildRouteSmokeChatRowsOptions) => {
  const threads = Array.from({ length: count }, (_, index) => ({
    id: createSafeId<"chatThread">(),
    organizationId,
    userId,
    workspaceId,
    title: `Scale thread ${String(index).padStart(4, "0")}`,
    contextMatterIds: [workspaceId],
    dataWorkspaceIds: [workspaceId],
  }));
  const messages = threads.map(({ id: threadId }) => {
    const id = createSafeId<"chatMessage">();
    const role = "user";
    return {
      id,
      threadId,
      workspaceId,
      userId,
      role,
      content: chatMessageContentFromMessage(
        toPersistableChatMessage({
          id,
          role,
          parts: [{ type: "text", content: "Route smoke fixture message." }],
        }),
      ),
    } as const;
  });
  return { threads, messages };
};
