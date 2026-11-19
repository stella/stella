import type { ChatSendRequest } from "@stll/api-contract/chat";

import type { SafeId } from "@/api/lib/branded-types";
import { appendMissingWorkspaceIds } from "@/api/lib/chat/data-scope";

/**
 * The thread fields a chat's first message decides.
 *
 * A thread row can exist before its first message: a setting chosen in a new
 * chat's composer (model, web search) or a surface that opens an empty chat
 * stores the row early, without what the first send carries. Until the thread
 * holds a message, the send that writes the first one therefore decides these
 * fields exactly as if it had created the row. Once the thread holds one, they
 * are the thread's own and no later send changes them here.
 */
export type SendThreadFields = {
  activeSkill: NonNullable<ChatSendRequest["activeSkill"]> | null;
  contextMatterIds: SafeId<"workspace">[];
  dataWorkspaceIds: SafeId<"workspace">[];
  subjectDecisionId: SafeId<"caseLawDecision"> | null;
};

/** What a send carries for the fields its thread's first message decides. */
export type SendThreadFieldsRequest = {
  /** Undefined when the send names no skill. */
  activeSkill: NonNullable<ChatSendRequest["activeSkill"]> | undefined;
  /** Undefined when the send names no pins: an empty thread keeps its own. */
  contextMatterIds: readonly SafeId<"workspace">[] | undefined;
  /**
   * Server-derived workspaces whose content the send's context embeds (an
   * origin draft's scope, the chat's own matter). Only ever widens the scope.
   */
  dataWorkspaceIds: readonly SafeId<"workspace">[];
  /** Null when the send is about no decision. */
  subjectDecisionId: SafeId<"caseLawDecision"> | null;
};

/** A stored thread row, as far as the send's thread fields go. */
export type StoredSendThread = {
  fields: SendThreadFields;
  /** Whether the thread holds any message yet. */
  hasMessages: boolean;
};

const NO_STORED_FIELDS: SendThreadFields = {
  activeSkill: null,
  contextMatterIds: [],
  dataWorkspaceIds: [],
  subjectDecisionId: null,
};

/**
 * The skill a send runs its thread with, by the rule of
 * `resolveSendThreadFields`. Validation knows the send's skill before the
 * rest of what it carries, so it reads the skill here.
 */
export const resolveSendThreadSkill = ({
  activeSkill,
  stored,
}: {
  activeSkill: SendThreadFieldsRequest["activeSkill"];
  stored: StoredSendThread | null;
}): SendThreadFields["activeSkill"] =>
  stored?.hasMessages === true
    ? stored.fields.activeSkill
    : (activeSkill ?? stored?.fields.activeSkill ?? null);

/**
 * The fields a send runs its thread with, and the values a row it creates or
 * adopts stores. A thread that holds a message keeps its stored values. A
 * missing thread, or one that holds no message yet, takes each value the send
 * carries and keeps a stored one only where the send carries none; its data
 * scope is the union of both, so adopting a row never narrows what RLS admits.
 */
export const resolveSendThreadFields = ({
  request,
  stored,
}: {
  request: SendThreadFieldsRequest;
  stored: StoredSendThread | null;
}): SendThreadFields => {
  if (stored?.hasMessages === true) {
    return stored.fields;
  }
  const base = stored?.fields ?? NO_STORED_FIELDS;
  return {
    activeSkill: resolveSendThreadSkill({
      activeSkill: request.activeSkill,
      stored,
    }),
    contextMatterIds:
      request.contextMatterIds === undefined
        ? base.contextMatterIds
        : [...request.contextMatterIds],
    dataWorkspaceIds: appendMissingWorkspaceIds({
      additions: request.dataWorkspaceIds,
      base: base.dataWorkspaceIds,
    }),
    subjectDecisionId: request.subjectDecisionId ?? base.subjectDecisionId,
  };
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length &&
  left.every((id, index) => id === right[index]);

const sameSkill = (
  left: SendThreadFields["activeSkill"],
  right: SendThreadFields["activeSkill"],
): boolean =>
  left?.skillName === right?.skillName && left?.skillId === right?.skillId;

/** Logged once for a send whose carried context its thread does not run with. */
export const CHAT_SEND_CONTEXT_IGNORED_EVENT = "chat.send.context_ignored";

/**
 * The fields a thread that holds a message keeps whatever a send carries. A
 * send still applies its pins to such a thread itself, and its data scope only
 * ever widens, so neither can be ignored.
 */
export type IgnoredSendThreadField = Extract<
  keyof SendThreadFields,
  "activeSkill" | "subjectDecisionId"
>;

/** What a send carries for the fields its thread may run without. */
type IgnorableSendRequest = Pick<
  SendThreadFieldsRequest,
  IgnoredSendThreadField
>;

/** Per field, whether the send carried a value its thread runs without. */
const IGNORED_WHEN = {
  activeSkill: (request, resolved) =>
    request.activeSkill !== undefined &&
    !sameSkill(request.activeSkill, resolved.activeSkill),
  subjectDecisionId: (request, resolved) =>
    request.subjectDecisionId !== null &&
    request.subjectDecisionId !== resolved.subjectDecisionId,
} as const satisfies Record<
  IgnoredSendThreadField,
  (request: IgnorableSendRequest, resolved: SendThreadFields) => boolean
>;

const IGNORABLE_SEND_THREAD_FIELDS = Object.keys(IGNORED_WHEN).filter(
  (field): field is IgnoredSendThreadField =>
    Object.hasOwn(IGNORED_WHEN, field),
);

/**
 * The fields a send carried that its thread does not run with, by name: what
 * `resolveSendThreadFields` resolved differs from what the send asked for.
 * Empty for a send that creates or adopts its thread.
 */
export const ignoredSendThreadFields = ({
  request,
  resolved,
}: {
  request: IgnorableSendRequest;
  resolved: SendThreadFields;
}): IgnoredSendThreadField[] =>
  IGNORABLE_SEND_THREAD_FIELDS.filter((field) =>
    IGNORED_WHEN[field](request, resolved),
  );

/** Whether adopting `next` changes anything `stored` holds. */
export const sendThreadFieldsChanged = (
  stored: SendThreadFields,
  next: SendThreadFields,
): boolean =>
  !sameSkill(stored.activeSkill, next.activeSkill) ||
  !sameIds(stored.contextMatterIds, next.contextMatterIds) ||
  !sameIds(stored.dataWorkspaceIds, next.dataWorkspaceIds) ||
  stored.subjectDecisionId !== next.subjectDecisionId;

/**
 * The audit diff of adopting `next` over `stored`, limited to the identifiers
 * a chat thread's audit entry may carry: the skill and the decision are named
 * content, so they stay out of `changes` as they do on creation.
 */
export const sendThreadFieldsAuditChanges = (
  stored: SendThreadFields,
  next: SendThreadFields,
) => ({
  ...(sameIds(stored.contextMatterIds, next.contextMatterIds)
    ? {}
    : {
        contextMatterIds: {
          old: [...stored.contextMatterIds],
          new: [...next.contextMatterIds],
        },
      }),
  ...(sameIds(stored.dataWorkspaceIds, next.dataWorkspaceIds)
    ? {}
    : {
        dataWorkspaceIds: {
          old: [...stored.dataWorkspaceIds],
          new: [...next.dataWorkspaceIds],
        },
      }),
});
