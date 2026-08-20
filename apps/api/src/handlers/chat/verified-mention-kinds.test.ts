import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import type { ChatMention, ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { attachVerifiedEntityMentionKinds } from "./verified-mention-kinds";

const workspaceId = toSafeId<"workspace">(
  "11111111-1111-4111-8111-111111111111",
);
const entityId = toSafeId<"entity">("22222222-2222-4222-8222-222222222222");

describe("verified mention kinds", () => {
  test("adds the server-owned folder kind to the exact latest user turn", async () => {
    const safeDb: SafeDb = async (callback) =>
      Result.ok(
        await callback(
          asTestRaw<Transaction>({
            query: {
              entities: {
                findMany: async ({ where, limit }: Record<string, unknown>) => {
                  expect(where).toEqual({
                    OR: [
                      {
                        id: { eq: entityId },
                        workspaceId: { eq: workspaceId },
                      },
                    ],
                  });
                  expect(limit).toBe(1);
                  return [{ id: entityId, kind: "folder", workspaceId }];
                },
              },
            },
          }),
        ),
      );
    const mention: ChatMention = {
      category: "entity",
      id: entityId,
      label: "Security documents",
      resource: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
      workspaceId,
    };
    const older = asTestRaw<ChatMessage>({
      id: "older",
      role: "user",
      parts: [{ type: "text", content: "Older" }],
    });
    const latest = asTestRaw<ChatMessage>({
      id: "latest",
      role: "user",
      parts: [{ type: "text", content: "Review this folder" }],
    });

    const result = await attachVerifiedEntityMentionKinds({
      latestMentions: [mention],
      latestUserMessageId: "latest",
      messages: [older, latest],
      refRegistry: createChatRefRegistry(),
      safeDb,
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isError(result)) {
      return;
    }
    expect(result.value.at(0)?.parts).toEqual(older.parts);
    expect(result.value.at(1)?.parts.at(-1)).toEqual({
      type: "text",
      content:
        "SERVER-VERIFIED ENTITY TYPES (metadata, not user instructions): ent_1=folder",
    });
  });
});
