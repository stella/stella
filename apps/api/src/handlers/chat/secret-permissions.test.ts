import { Result } from "better-result";
import { expect, test } from "bun:test";

import savedSecret from "@/api/handlers/chat/saved-secret";
import submitSecret from "@/api/handlers/chat/submit-secret";
import { createSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { authorizedMemberRole } from "@/api/lib/permission-authorization";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";

// A chat-only credential passes the declared chat permission but holds no
// connector access, so only the handlers' own connector check refuses it.
const chatOnlyMember = () =>
  authorizedMemberRole({
    role: "member",
    credential: { type: "attenuated", permissions: { chat: ["create"] } },
  });

const countingSafeDb = () => {
  const reads = { count: 0 };
  const safeDb = async () => {
    reads.count += 1;
    return await Promise.resolve(
      Result.err(
        new DatabaseError({ message: "Database must not be read on denial" }),
      ),
    );
  };
  return { reads, safeDb };
};

const connectorAccessRefusal = {
  code: 403,
  response: { message: "Connector access is unavailable" },
};

test("refuses the saved-credential read without connector access before any database read", async () => {
  const { reads, safeDb } = countingSafeDb();
  const result = await savedSecret.handler(
    createTestHandlerContext<Parameters<typeof savedSecret.handler>[0]>({
      memberRole: chatOnlyMember(),
      safeDb,
      scopedDb: NO_DB,
      audit: NO_AUDIT,
      params: { threadId: createSafeId<"chatThread">() },
      query: { connectorSlug: "sample-connector" },
    }),
  );
  expect(reads.count).toBe(0);
  expect(result).toMatchObject(connectorAccessRefusal);
});

test("refuses a provided credential without connector access before any database read", async () => {
  const { reads, safeDb } = countingSafeDb();
  const result = await submitSecret.handler(
    createTestHandlerContext<Parameters<typeof submitSecret.handler>[0]>({
      memberRole: chatOnlyMember(),
      safeDb,
      scopedDb: NO_DB,
      audit: NO_AUDIT,
      params: {
        threadId: createSafeId<"chatThread">(),
        toolCallId: "sample-request",
      },
      body: {
        decision: "provide",
        value: "sample-value",
        saveForFuture: false,
        normalConnectionAction: "preserve",
        targetConnection: {
          connectionId: "00000000-0000-4000-8000-000000000001",
          host: "sample.test",
        },
      },
    }),
  );
  expect(reads.count).toBe(0);
  expect(result).toMatchObject(connectorAccessRefusal);
});
