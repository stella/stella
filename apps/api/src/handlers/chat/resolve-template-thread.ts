import { Result } from "better-result";
import { t } from "elysia";

import {
  createTemplateChatThread,
  findTemplateChatThread,
  findTemplateTitle,
  writeTemplateChatThreadMapping,
} from "@/api/handlers/chat/template-thread-shared";
import type { TemplateThreadScope } from "@/api/handlers/chat/template-thread-shared";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { DatabaseError, HandlerError } from "@/api/lib/errors/tagged-errors";
import { PG_ERROR } from "@/api/lib/pg-error";

const config = {
  permissions: { chat: ["create"] },
  body: t.Object({
    templateId: tSafeId("template"),
  }),
} satisfies HandlerConfig;

/**
 * Returns the caller's latest chat thread for a template, creating
 * the thread + mapping on first visit. The Template Studio sibling
 * of `resolve-file-thread`: reopening a template resumes the same
 * conversation instead of starting a fresh one.
 */
const resolveTemplateThread = createSafeRootHandler(
  config,
  async function* ({ body, recordAuditEvent, safeDb, session, user }) {
    const scope: TemplateThreadScope = {
      templateId: body.templateId,
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };

    const txResult = await safeDb(async (tx) => {
      const existing = await findTemplateChatThread(tx, scope);

      if (existing) {
        return { ok: true as const, chatThreadId: existing.chatThreadId };
      }

      const title = await findTemplateTitle(tx, scope);

      if (title === undefined) {
        return { ok: false as const };
      }

      const chatThreadId = await createTemplateChatThread(
        tx,
        scope,
        title,
        recordAuditEvent,
      );
      await writeTemplateChatThreadMapping(tx, {
        chatThreadId,
        mode: "insert",
        recordAuditEvent,
        scope,
      });

      return { ok: true as const, chatThreadId };
    });

    if (Result.isError(txResult)) {
      if (
        !DatabaseError.is(txResult.error) ||
        txResult.error.code !== PG_ERROR.UNIQUE_VIOLATION
      ) {
        return yield* Result.err(txResult.error);
      }

      // Lost a create race; the winner's mapping is the answer.
      const recovered = yield* Result.await(
        safeDb(async (tx) => await findTemplateChatThread(tx, scope)),
      );

      if (recovered) {
        return Result.ok({ threadId: recovered.chatThreadId });
      }

      return yield* Result.err(
        new HandlerError({
          status: 404,
          message: "Template not found",
        }),
      );
    }

    if (!txResult.value.ok) {
      return yield* Result.err(
        new HandlerError({
          status: 404,
          message: "Template not found",
        }),
      );
    }

    return Result.ok({ threadId: txResult.value.chatThreadId });
  },
);

export default resolveTemplateThread;
