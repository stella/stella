import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  promptShortcuts,
  RESERVED_SHORTCUT_COMMANDS,
  SHORTCUT_COMMAND_PATTERN,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";

const createShortcutBodySchema = t.Object({
  scope: t.UnionEnum(["team", "private"]),
  name: t.String({ minLength: 1, maxLength: 256 }),
  description: t.Optional(t.String({ maxLength: 1024 })),
  command: t.String({ minLength: 1, maxLength: 50 }),
  prompt: t.String({ minLength: 1 }),
});

const config = {
  permissions: { promptShortcut: ["create"] },
  body: createShortcutBodySchema,
} satisfies HandlerConfig;

const createShortcut = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, memberRole }) {
    const userCount = yield* Result.await(
      safeDb((tx) =>
        tx.$count(
          promptShortcuts,
          and(
            eq(promptShortcuts.organizationId, session.activeOrganizationId),
            eq(promptShortcuts.userId, user.id),
          ),
        ),
      ),
    );

    if (userCount >= LIMITS.shortcutsPerUser) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Shortcut limit reached for this user",
        }),
      );
    }

    if (!SHORTCUT_COMMAND_PATTERN.test(body.command)) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Command must start with a letter or digit and contain only lowercase letters, digits, hyphens, and underscores",
        }),
      );
    }

    if (
      (RESERVED_SHORTCUT_COMMANDS as readonly string[]).includes(body.command)
    ) {
      return Result.err(
        new HandlerError({
          status: 400,
          message: `"/${body.command}" is a reserved command`,
        }),
      );
    }

    if (
      body.scope === "team" &&
      !["admin", "owner"].includes(memberRole.role)
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          message: "Only admins and owners can create team shortcuts",
        }),
      );
    }

    const insertResult = await safeDb((tx) =>
      tx
        .insert(promptShortcuts)
        .values({
          organizationId: session.activeOrganizationId,
          userId: user.id,
          scope: body.scope,
          name: body.name,
          description: body.description ?? null,
          command: body.command,
          prompt: body.prompt,
          isDefault: false,
        })
        .returning({ id: promptShortcuts.id }),
    );

    if (Result.isError(insertResult)) {
      if (
        DatabaseError.is(insertResult.error) &&
        insertResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: `A shortcut with command "/${body.command}" already exists`,
          }),
        );
      }
      return Result.err(insertResult.error);
    }

    const row = insertResult.value.at(0);
    if (!row) {
      panic("Failed to create shortcut");
    }

    return Result.ok({ id: row.id });
  },
);

export default createShortcut;
