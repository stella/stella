import { Result } from "better-result";
import { t } from "elysia";

import {
  createTemplateChatThread,
  findTemplateTitle,
  writeTemplateChatThreadMapping,
} from "@/api/handlers/chat/template-thread-shared";
import type { TemplateThreadScope } from "@/api/handlers/chat/template-thread-shared";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { chat: ["create"] },
  body: t.Object({
    templateId: tSafeId("template"),
  }),
} satisfies HandlerConfig;

/**
 * "New chat" in the Template Studio: creates a fresh thread and
 * repoints the caller's template mapping at it, so the next visit
 * resumes the new conversation. Older threads stay reachable from
 * the chat history list.
 */
const rotateTemplateThread = createSafeRootHandler(
  config,
  async function* ({ body, recordAuditEvent, safeDb, session, user }) {
    const scope: TemplateThreadScope = {
      templateId: body.templateId,
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };

    const txResult = yield* Result.await(
      safeDb(async (tx) => {
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
          mode: "upsert",
          recordAuditEvent,
          scope,
        });

        return { ok: true as const, chatThreadId };
      }),
    );

    if (!txResult.ok) {
      return yield* Result.err(
        new HandlerError({
          status: 404,
          message: "Template not found",
        }),
      );
    }

    return Result.ok({ threadId: txResult.chatThreadId });
  },
);

export default rotateTemplateThread;
