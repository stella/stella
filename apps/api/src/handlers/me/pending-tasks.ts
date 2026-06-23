import { Result } from "better-result";

import { createSafeSessionHandler } from "@/api/lib/api-handlers";
import { getPendingTasksAndMembers } from "@/api/lib/delete-account";

const config = {};

const deleteAccountPendingTasks = createSafeSessionHandler(
  config,
  async function* (ctx) {
    const currentUserId = ctx.user.id;

    const data = yield* Result.await(getPendingTasksAndMembers(currentUserId));

    return Result.ok(data);
  },
);

export default deleteAccountPendingTasks;
