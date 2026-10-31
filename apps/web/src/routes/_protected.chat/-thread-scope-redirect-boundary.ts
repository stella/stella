import { redirect } from "@tanstack/react-router";

import { readThreadScopeRedirect } from "./-thread-scope-redirect";

export const redirectThreadScopeError = (
  error: unknown,
  threadId: string,
): never => {
  const target = readThreadScopeRedirect(error, threadId);
  if (target !== null) {
    throw redirect(target);
  }
  throw error;
};
