export const CHAT_THREAD_SCOPE_MISMATCH_CODE =
  "chat_thread_scope_mismatch" as const;

export type ChatThreadScopeMismatch = {
  code: typeof CHAT_THREAD_SCOPE_MISMATCH_CODE;
  workspaceId: string;
};

export const readChatThreadScopeMismatch = (
  value: unknown,
): ChatThreadScopeMismatch | null => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("code" in value) ||
    value.code !== CHAT_THREAD_SCOPE_MISMATCH_CODE ||
    !("workspaceId" in value) ||
    typeof value.workspaceId !== "string"
  ) {
    return null;
  }

  return {
    code: CHAT_THREAD_SCOPE_MISMATCH_CODE,
    workspaceId: value.workspaceId,
  };
};
