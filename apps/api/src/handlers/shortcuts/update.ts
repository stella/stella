import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import {
  promptShortcuts,
  RESERVED_SHORTCUT_COMMANDS,
  SHORTCUT_COMMAND_PATTERN,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

const updateShortcutParamsSchema = t.Object({
  shortcutId: tSafeId("promptShortcut"),
});

const updateShortcutBodySchema = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 256 })),
  description: t.Optional(t.Nullable(t.String({ maxLength: 1024 }))),
  command: t.Optional(t.String({ minLength: 1, maxLength: 50 })),
  prompt: t.Optional(t.String({ minLength: 1 })),
});

const config = {
  permissions: { promptShortcut: ["update"] },
  params: updateShortcutParamsSchema,
  body: updateShortcutBodySchema,
} satisfies HandlerConfig;

const updateShortcut = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    params,
    body,
    memberRole,
    recordAuditEvent,
  }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx
          .select({
            id: promptShortcuts.id,
            scope: promptShortcuts.scope,
            userId: promptShortcuts.userId,
            name: promptShortcuts.name,
            description: promptShortcuts.description,
            command: promptShortcuts.command,
            prompt: promptShortcuts.prompt,
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
          message: "Only admins and owners can edit team shortcuts",
        }),
      );
    }

    if (shortcut.scope === "private" && shortcut.userId !== user.id) {
      return Result.err(
        new HandlerError({ status: 403, message: "Forbidden" }),
      );
    }

    if (body.command !== undefined) {
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
    }

    const changes: FieldDiffs = {};
    if (body.name !== undefined && body.name !== shortcut.name) {
      changes["name"] = { old: shortcut.name, new: body.name };
    }
    if (
      body.description !== undefined &&
      body.description !== shortcut.description
    ) {
      changes["description"] = {
        old: shortcut.description,
        new: body.description,
      };
    }
    if (body.command !== undefined && body.command !== shortcut.command) {
      changes["command"] = { old: shortcut.command, new: body.command };
    }
    if (body.prompt !== undefined && body.prompt !== shortcut.prompt) {
      changes["prompt"] = { old: shortcut.prompt, new: body.prompt };
    }

    const updateResult = await safeDb(async (tx) => {
      const rows = await tx
        .update(promptShortcuts)
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.description !== undefined && {
            description: body.description,
          }),
          ...(body.command !== undefined && { command: body.command }),
          ...(body.prompt !== undefined && { prompt: body.prompt }),
          isDefault: false,
        })
        .where(eq(promptShortcuts.id, params.shortcutId))
        .returning({ id: promptShortcuts.id });

      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.PROMPT_SHORTCUT,
        resourceId: params.shortcutId,
        changes,
      });

      return rows;
    });

    if (Result.isError(updateResult)) {
      if (
        DatabaseError.is(updateResult.error) &&
        updateResult.error.code === PG_ERROR.UNIQUE_VIOLATION
      ) {
        return Result.err(
          new HandlerError({
            status: 409,
            message: `A shortcut with command "/${body.command}" already exists`,
          }),
        );
      }
      return Result.err(updateResult.error);
    }

    return Result.ok({ id: params.shortcutId });
  },
);

export default updateShortcut;
