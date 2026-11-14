import { Result } from "better-result";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as v from "valibot";

import type { SafeDb } from "@/api/db/safe-db";
import { chatThreads } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { resourceIdSchema } from "@/api/lib/custom-schema";

const config = {
  contract: "patch",
  description:
    "Find your own conversation about one case-law decision: the most " +
    "recently active of your global chat threads whose subject is that " +
    "decision, or null when you have none yet. A decision's chat is one " +
    "conversation, so a reader reopening the decision continues it rather " +
    "than starting another.",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "chat_thread_ui",
    consumesServices: false,
  },
  params: v.object({ decisionId: resourceIdSchema("caseLawDecision") }),
} satisfies HandlerConfig;

type FindDecisionChatThreadOptions = {
  decisionId: SafeId<"caseLawDecision">;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  userId: string;
};

/**
 * The caller's conversation about a decision. Global threads only: a chat
 * about a decision is opened from the public reader, never inside a matter,
 * and the reader's chat must not land in a matter's conversation. The newest
 * wins when an earlier "new chat" left more than one.
 */
export const findDecisionChatThread = async ({
  decisionId,
  organizationId,
  safeDb,
  userId,
}: FindDecisionChatThreadOptions) =>
  await safeDb(async (tx) => {
    const [row] = await tx
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.organizationId, organizationId),
          eq(chatThreads.userId, userId),
          eq(chatThreads.subjectDecisionId, decisionId),
          isNull(chatThreads.workspaceId),
        ),
      )
      .orderBy(desc(chatThreads.updatedAt), desc(chatThreads.id))
      .limit(1);
    return { threadId: row?.id ?? null };
  });

const getDecisionChatThread = createSafeRootHandler(
  config,
  async function* ({ params, safeDb, session, user }) {
    const found = yield* Result.await(
      findDecisionChatThread({
        decisionId: params.decisionId,
        organizationId: session.activeOrganizationId,
        safeDb,
        userId: user.id,
      }),
    );
    return Result.ok(found);
  },
);

export default getDecisionChatThread;
