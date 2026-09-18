import { panic, Result } from "better-result";
import { sql } from "drizzle-orm";
import { t } from "elysia";

import { SIGNAL_VIEW } from "@stll/api-contract/signals";

import { entities, signals } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { canTriageSignals, signalListConditions } from "@/api/lib/signals/read";
import { dueAssignedTaskCondition } from "@/api/lib/tasks/assigned";
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
    // One statement for both halves: the badge polls on every page.
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            openSignals: tx.$count(
              signals,
              signalListConditions({
                organizationId,
                canTriage: canTriageSignals(memberRole),
                view: SIGNAL_VIEW.OPEN,
                now: new Date(),
              }),
            ),
            dueTasks: tx.$count(
              entities,
              dueAssignedTaskCondition({
                organizationId,
                userId: user.id,
                asOf: resolveWorkAsOf(query.asOf),
              }),
            ),
          })
          .from(sql`(VALUES (1)) AS badge(one)`),
      ),
    );
    const counts = rows.at(0) ?? panic("Badge count returned no row");
    return Result.ok({ count: counts.openSignals + counts.dueTasks });
  },
);

export default countInbox;
