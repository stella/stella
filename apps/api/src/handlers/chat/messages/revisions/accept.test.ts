import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { PgTable } from "drizzle-orm/pg-core";

import {
  CHAT_MESSAGE_EDIT_TYPE,
  CHAT_MESSAGE_EDIT_FORMAT,
} from "@stll/api-contract/chat-message-revisions";
import { sha256Hex } from "@stll/sha256/bun";

import { chatMessages, chatThreads } from "@/api/db/schema";
import acceptMessageRevision from "@/api/handlers/chat/messages/revisions/accept";
import { createSafeId } from "@/api/lib/branded-types";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
} from "@/api/tests/helpers/handler-context";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

describe("accepting chat answer revisions", () => {
  test.each(["baseRevision", "selectedTextHash"] as const)(
    "rejects a stale %s before writing any answer or snapshot",
    async (staleField) => {
      const threadId = createSafeId<"chatThread">();
      const messageId = createSafeId<"chatMessage">();
      const userId = mintAuthProviderId<"user">();
      const organizationId = mintAuthProviderId<"organization">();
      const content = {
        version: 3,
        data: [{ type: "text", content: "Original answer." }],
      } as const;
      let writes = 0;
      const persist = () => {
        writes += 1;
        throw new TypeError("Stale answer must not reach persistence");
      };
      const { safeDb, scopedDb } = createScopedDbMock({
        select: () => ({
          from: (table: PgTable) => {
            const query = drizzle.mock().select().from(table);
            const rows = [];
            if (table === chatThreads) {
              rows.push({
                id: threadId,
                organizationId,
                userId,
                workspaceId: null,
              });
            }
            if (table === chatMessages) {
              rows.push({
                id: messageId,
                threadId,
                workspaceId: null,
                role: "assistant",
                revision: 2,
                content,
              });
            }
            return {
              toSQL: () => query.toSQL(),
              as: (alias: string) => query.as(alias),
              where: () => ({
                toSQL: () => query.where(sql`true`).toSQL(),
                for: async () => await Promise.resolve(rows),
                limit: async () => await Promise.resolve(rows),
              }),
            };
          },
        }),
        insert: persist,
        update: persist,
        delete: persist,
      });
      const baseRevision = staleField === "baseRevision" ? 1 : 2;
      const selectedTextHash = sha256Hex(
        staleField === "selectedTextHash" ? "Changed" : "Original",
      );
      if (staleField === "baseRevision") {
        expect(baseRevision).not.toBe(2);
      } else {
        expect(selectedTextHash).not.toBe(sha256Hex("Original"));
      }
      const response = await acceptMessageRevision.handler(
        createTestHandlerContext<
          Parameters<typeof acceptMessageRevision.handler>[0]
        >({
          safeDb,
          scopedDb,
          audit: NO_AUDIT,
          user: { id: userId },
          session: { activeOrganizationId: organizationId },
          params: { threadId, messageId },
          body: {
            baseRevision,
            selectedTextHash,
            content: {
              version: 3,
              data: [{ type: "text", content: "**Original** answer." }],
            },
            edit: {
              type: CHAT_MESSAGE_EDIT_TYPE.format,
              format: CHAT_MESSAGE_EDIT_FORMAT.bold,
              start: 0,
              end: 8,
            },
          },
        }),
      );
      expect(response).toMatchObject({
        code: 409,
        response: { code: VERSION_CONFLICT_ERROR_CODE },
      });
      expect(writes).toBe(0);
    },
  );
});
