import { CHAT_THREAD_TITLE_MAX_LENGTH } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

import { seedId } from "./seed-utils";

type TemplateChatSeedInput = {
  organizationId: SafeId<"organization">;
  templates: readonly { label: string; name: string; id: SafeId<"template"> }[];
  authorIds: readonly string[];
};

export const buildTemplateChatSeedRows = ({
  authorIds,
  organizationId,
  templates,
}: TemplateChatSeedInput) => {
  const threads = templates.flatMap((template) =>
    authorIds.map((userId) => {
      const chatThreadId = seedId<"chatThread">(
        `${organizationId}:template-chat-${template.label}-${userId}`,
      );

      return {
        id: chatThreadId,
        organizationId,
        userId,
        title: template.name.slice(0, CHAT_THREAD_TITLE_MAX_LENGTH),
        contextMatterIds: [],
        dataWorkspaceIds: [],
      };
    }),
  );
  const mappings = templates.flatMap((template) =>
    authorIds.map((userId) => ({
      id: seedId<"templateChatThread">(
        `${organizationId}:template-chat-mapping-${template.label}-${userId}`,
      ),
      organizationId,
      userId,
      templateId: template.id,
      chatThreadId: seedId<"chatThread">(
        `${organizationId}:template-chat-${template.label}-${userId}`,
      ),
    })),
  );

  return { threads, mappings };
};
