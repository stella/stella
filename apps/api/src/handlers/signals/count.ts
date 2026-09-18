import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { canTriageSignals, countOpenSignals } from "@/api/lib/signals/read";
import { countDueAssignedTasks } from "@/api/lib/tasks/assigned";
import { resolveWorkAsOf } from "@/api/lib/work-obligations/at-risk";

const config = {
  description:
    "Count what needs the caller in the Inbox: open signals visible to them " +
    "plus their unfinished tasks due on or before `asOf`; feeds the " +
    "navigation badge.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
  query: t.Object({
    asOf: t.Optional(
      t.String({
        format: "date",
        description:
          "The caller's calendar day (YYYY-MM-DD); defaults to the server's UTC day",
      }),
    ),
  }),
} satisfies HandlerConfig;

const countInbox = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, memberRole, query }) {
    const organizationId = session.activeOrganizationId;
    const [openSignalsResult, dueTasksResult] = await Promise.all([
      countOpenSignals({
        safeDb,
        organizationId,
        canTriage: canTriageSignals(memberRole),
      }),
      countDueAssignedTasks({
        safeDb,
        organizationId,
        userId: user.id,
        asOf: resolveWorkAsOf(query.asOf),
      }),
    ]);
    const openSignals = yield* openSignalsResult;
    const dueTasks = yield* dueTasksResult;
    return Result.ok({ count: openSignals + dueTasks });
  },
);

export default countInbox;
