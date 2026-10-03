import { Result } from "better-result";

import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import type { SessionHandlerConfig } from "@/api/lib/api-handlers";
import { ACCOUNT_ACCESS } from "@/api/lib/auth/demo-account-policy";
import { getPendingTasksAndMembers } from "@/api/lib/delete-account";

const config = {
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "account_lifecycle" },
} satisfies SessionHandlerConfig;

const deleteAccountPendingTasks = createSafeSessionHandler(
  config,
  async function* (ctx) {
    const currentUserId = ctx.user.id;

    const data = yield* Result.await(getPendingTasksAndMembers(currentUserId));

    return Result.ok(data);
  },
);

export default deleteAccountPendingTasks;
