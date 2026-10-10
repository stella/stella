import { and, eq, inArray } from "drizzle-orm";
import type { PgAsyncDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import {
  CHAT_THREAD_TITLE_MAX_LENGTH,
  chatThreads,
  templateChatThreads,
} from "@/api/db/schema";
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

export const seedTemplateChatThreads = async (
  tx: Pick<PgAsyncDatabase<PgQueryResultHKT>, "select" | "insert">,
  input: TemplateChatSeedInput,
) => {
  const { organizationId } = input;
  const rows = buildTemplateChatSeedRows(input);
  const existingMappings = await tx
    .select({
      templateId: templateChatThreads.templateId,
      userId: templateChatThreads.userId,
    })
    .from(templateChatThreads)
    .where(
      and(
        eq(templateChatThreads.organizationId, organizationId),
        inArray(
          templateChatThreads.templateId,
          rows.mappings.map(({ templateId }) => templateId),
        ),
        inArray(
          templateChatThreads.userId,
          rows.mappings.map(({ userId }) => userId),
        ),
      ),
    );
  const existingScopes = new Set(
    existingMappings.map(({ templateId, userId }) => `${templateId}:${userId}`),
  );
  const newMappings = rows.mappings.filter(
    ({ templateId, userId }) => !existingScopes.has(`${templateId}:${userId}`),
  );
  const newThreadIds = new Set(
    newMappings.map(({ chatThreadId }) => chatThreadId),
  );
  const newThreads = rows.threads.filter(({ id }) => newThreadIds.has(id));
  if (newMappings.length === 0) {
    return rows.mappings.length;
  }

  await tx.insert(chatThreads).values(newThreads).onConflictDoNothing();
  await tx
    .insert(templateChatThreads)
    .values(newMappings)
    .onConflictDoNothing();
  return rows.mappings.length;
};
