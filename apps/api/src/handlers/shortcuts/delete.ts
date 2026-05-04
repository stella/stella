import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { promptShortcuts } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const deleteShortcutParamsSchema = t.Object({
  shortcutId: tSafeId("promptShortcut"),
});

const config = {
  permissions: { promptShortcut: ["delete"] },
  params: deleteShortcutParamsSchema,
} satisfies HandlerConfig;

const deleteShortcut = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, params, memberRole }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: promptShortcuts.id,
            scope: promptShortcuts.scope,
            userId: promptShortcuts.userId,
          })
          .from(promptShortcuts)
          .where(
            and(
              eq(promptShortcuts.id, params.shortcutId),
              eq(promptShortcuts.organizationId, session.activeOrganizationId),
            ),
          )
          .limit(1),
      ),
    );

    const shortcut = existing.at(0);
    if (!shortcut) {
      return Result.err(
        new HandlerError({ status: 404, message: "Shortcut not found" }),
      );
    }

    if (
      shortcut.scope === "team" &&
      !["admin", "owner"].includes(memberRole.role)
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Only admins and owners can delete team shortcuts",
        }),
      );
    }

    if (shortcut.scope === "private" && shortcut.userId !== user.id) {
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }

    yield* Result.await(
      safeDb((tx) =>
        tx
          .delete(promptShortcuts)
          .where(eq(promptShortcuts.id, params.shortcutId)),
      ),
    );

    return Result.ok({ id: params.shortcutId });
  },
);

export default deleteShortcut;
