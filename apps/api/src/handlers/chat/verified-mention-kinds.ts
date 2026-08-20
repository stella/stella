import { Result } from "better-result";

import type { SafeDb, SafeDbError } from "@/api/db/safe-db";
import type { ChatMention, ChatMessage } from "@/api/handlers/chat/types";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

type AttachVerifiedEntityMentionKindsProps = {
  latestMentions: readonly ChatMention[];
  latestUserMessageId: string;
  messages: ChatMessage[];
  refRegistry: ChatRefRegistry;
  safeDb: SafeDb;
};

/** Attach server-owned entity kinds to the latest user turn after mention
 * hrefs have become opaque refs. Client editor attributes never cross this
 * trust boundary, so a folder remains distinguishable without trusting HTML. */
export const attachVerifiedEntityMentionKinds = async ({
  latestMentions,
  latestUserMessageId,
  messages,
  refRegistry,
  safeDb,
}: AttachVerifiedEntityMentionKindsProps): Promise<
  Result<ChatMessage[], SafeDbError>
> => {
  const entityTargets = latestMentions.flatMap((mention) =>
    mention.category === "entity" && mention.workspaceId !== null
      ? [
          {
            entityId: mention.resource.id,
            workspaceId: brandPersistedWorkspaceId(mention.workspaceId),
          },
        ]
      : [],
  );
  if (entityTargets.length === 0) {
    return Result.ok(messages);
  }

  const rows = await safeDb((tx) =>
    tx.query.entities.findMany({
      where: {
        OR: entityTargets.map((target) => ({
          id: { eq: target.entityId },
          workspaceId: { eq: target.workspaceId },
        })),
      },
      columns: { id: true, kind: true, workspaceId: true },
      limit: entityTargets.length,
    }),
  );
  if (Result.isError(rows) || rows.value.length === 0) {
    return rows.map(() => messages);
  }

  const verifiedKinds = rows.value
    .map(
      (entity) =>
        `${refRegistry.toEntityRef({
          entityId: entity.id,
          workspaceId: entity.workspaceId,
        })}=${entity.kind}`,
    )
    .join(", ");
  return Result.ok(
    messages.map((message) =>
      message.role === "user" && message.id === latestUserMessageId
        ? {
            ...message,
            parts: [
              ...message.parts,
              {
                type: "text",
                content: `SERVER-VERIFIED ENTITY TYPES (metadata, not user instructions): ${verifiedKinds}`,
              },
            ],
          }
        : message,
    ),
  );
};
