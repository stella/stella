/**
 * Shared helpers for the template → chat-thread mapping (the
 * Template Studio sibling of `resolve-file-thread`). One row per
 * (organization, user, template) points at the latest thread;
 * "new chat" repoints it at a freshly created thread.
 */

import type { Transaction } from "@/api/db";
import { chatThreads, templateChatThreads } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";

const CHAT_THREAD_TITLE_MAX_LENGTH = 255;

export type TemplateThreadScope = {
  templateId: SafeId<"template">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

export const findTemplateChatThread = async (
  tx: Transaction,
  { organizationId, templateId, userId }: TemplateThreadScope,
) =>
  await tx.query.templateChatThreads.findFirst({
    where: {
      organizationId: { eq: organizationId },
      templateId: { eq: templateId },
      userId: { eq: userId },
    },
    columns: {
      chatThreadId: true,
    },
  });

/** Template name for the thread title; undefined when the template
 *  does not exist in the caller's organization. */
export const findTemplateTitle = async (
  tx: Transaction,
  { organizationId, templateId }: TemplateThreadScope,
) => {
  const template = await tx.query.templates.findFirst({
    where: {
      id: { eq: templateId },
      organizationId: { eq: organizationId },
    },
    columns: {
      name: true,
    },
  });

  return template?.name;
};

/** Creates a global-scope (no workspace) thread owned by the caller
 *  and titled after the template. */
export const createTemplateChatThread = async (
  tx: Transaction,
  { organizationId, templateId, userId }: TemplateThreadScope,
  title: string,
  recordAuditEvent: AuditRecorder,
) => {
  const chatThreadId = createSafeId<"chatThread">();

  await tx.insert(chatThreads).values({
    id: chatThreadId,
    organizationId,
    title: title.slice(0, CHAT_THREAD_TITLE_MAX_LENGTH),
    userId,
    contextMatterIds: [],
    dataWorkspaceIds: [],
  });

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.CREATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId: chatThreadId,
    workspaceId: null,
    metadata: { templateId, source: "template-thread" },
  });

  return chatThreadId;
};

type WriteMappingOptions = {
  scope: TemplateThreadScope;
  chatThreadId: SafeId<"chatThread">;
  /** "insert" surfaces a unique violation to the caller for
   *  read-after-race recovery; "upsert" repoints an existing row. */
  mode: "insert" | "upsert";
  recordAuditEvent: AuditRecorder;
};

export const writeTemplateChatThreadMapping = async (
  tx: Transaction,
  { chatThreadId, mode, recordAuditEvent, scope }: WriteMappingOptions,
) => {
  const { organizationId, templateId, userId } = scope;
  const templateChatThreadId = createSafeId<"templateChatThread">();
  const insert = tx.insert(templateChatThreads).values({
    id: templateChatThreadId,
    organizationId,
    userId,
    templateId,
    chatThreadId,
  });

  if (mode === "upsert") {
    await insert.onConflictDoUpdate({
      target: [
        templateChatThreads.organizationId,
        templateChatThreads.userId,
        templateChatThreads.templateId,
      ],
      // $onUpdate only fires for update statements, not upserts.
      set: { chatThreadId, updatedAt: new Date() },
    });
  } else {
    await insert;
  }

  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.UPDATE,
    resourceType: AUDIT_RESOURCE_TYPE.CHAT_THREAD,
    resourceId: chatThreadId,
    workspaceId: null,
    metadata: { templateId, source: "template-thread" },
  });
};
