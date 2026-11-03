import { readChatThreadScopeMismatch } from "@stll/api-contract/chat-thread-scope";

import { chatThreadRoute } from "@/lib/chat-thread-ref";
import { APIError } from "@/lib/errors/api";

export const readThreadScopeRedirect = (error: unknown, threadId: string) => {
  const mismatch = APIError.is(error)
    ? readChatThreadScopeMismatch({
        code: error.code,
        ...error.details,
      })
    : null;
  return mismatch === null
    ? null
    : chatThreadRoute({ threadId, workspaceId: mismatch.workspaceId });
};
