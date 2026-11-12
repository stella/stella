import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import type { ChatBackgroundTasks } from "@stll/api-contract/chat-background-tasks";
import { DESKTOP_RUNNER_MAX_BACKGROUND_TASKS } from "@stll/api-contract/desktop-runner";

import { chatThreads } from "@/api/db/schema";
import { CHAT_TURN_PERMISSIONS } from "@/api/handlers/chat/chat-turn-state";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { getDesktopRunnerControl } from "@/api/lib/desktop-runner/runtime";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const params = v.object({ threadId: resourceIdSchema("chatThread") });

const config = {
  contract: "patch",
  description:
    "How many tasks your chat's coding agent left running in the background " +
    "on your computer after its last turn, while the chat waits for its next " +
    "one. 0 when none, or when that computer is not connected. A chat you " +
    "cannot see is a 404.",
  permissions: CHAT_TURN_PERMISSIONS,
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "read",
  mcp: { type: "internal", reason: "chat_thread_ui" },
  params,
} satisfies HandlerConfig;

/** What the chat's agent left running in the background on its computer. */
const readBackgroundTasks = createSafeRootHandler(
  config,
  async function* ({ params: { threadId }, safeDb, session, user }) {
    const owner = {
      userId: user.id,
      organizationId: session.activeOrganizationId,
    };
    // The chat as the member's own scope sees it: chat RLS hides one whose
    // matter the member can no longer open.
    const visible = yield* Result.await(
      safeDb(async (tx) => {
        const [thread] = await tx
          .select({ id: chatThreads.id })
          .from(chatThreads)
          .where(
            and(
              eq(chatThreads.id, threadId),
              eq(chatThreads.organizationId, owner.organizationId),
              eq(chatThreads.userId, owner.userId),
            ),
          )
          .limit(1);
        return thread !== undefined;
      }),
    );
    if (!visible) {
      return Result.err(
        new HandlerError({
          status: 404,
          code: "not_found",
          message: "Chat thread not found",
        }),
      );
    }
    const count = yield* Result.await(
      getDesktopRunnerControl().control.readBackgroundTasks({
        owner,
        threadId,
      }),
    );
    const body: ChatBackgroundTasks = {
      count: Math.min(count, DESKTOP_RUNNER_MAX_BACKGROUND_TASKS),
    };
    return Result.ok(body);
  },
);

export default readBackgroundTasks;
