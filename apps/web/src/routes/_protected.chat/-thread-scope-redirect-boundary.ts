import { redirect } from "@tanstack/react-router";

import { readThreadScopeRedirect } from "./-thread-scope-redirect";

// The router reads a redirect, and a failed load, only from a rejected
// loader; the original error must reach it unwrapped.
export const loadThreadOrRedirect = async (
  load: () => Promise<unknown>,
  threadId: string,
) => {
  try {
    await load();
  } catch (error) {
    const target = readThreadScopeRedirect(error, threadId);
    if (target !== null) {
      throw redirect(target);
    }
    throw error;
  }
};
