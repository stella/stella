import { Result } from "better-result";
import { and, eq, or } from "drizzle-orm";

import { promptShortcuts, PROMPT_SHORTCUT_SCOPES } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  permissions: { promptShortcut: ["create"] },
} satisfies HandlerConfig;

const listShortcuts = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user }) {
    const rows = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: promptShortcuts.id,
            scope: promptShortcuts.scope,
            name: promptShortcuts.name,
            description: promptShortcuts.description,
            command: promptShortcuts.command,
            prompt: promptShortcuts.prompt,
            isDefault: promptShortcuts.isDefault,
            userId: promptShortcuts.userId,
          })
          .from(promptShortcuts)
          .where(
            and(
              eq(promptShortcuts.organizationId, session.activeOrganizationId),
              or(
                eq(promptShortcuts.scope, PROMPT_SHORTCUT_SCOPES[0]), // "team"
                eq(promptShortcuts.userId, user.id),
              ),
            ),
          )
          .orderBy(promptShortcuts.createdAt),
      ),
    );

    return Result.ok(rows);
  },
);

export default listShortcuts;
