import type { QueryClient } from "@tanstack/react-query";

/**
 * The prefix every organization's Knowledge query sits under, followed by the
 * organization id. Nothing a visitor without an account reads is kept here.
 */
export const memberKnowledgeKeys = {
  all: () => ["knowledge", "member"] as const,
};

/**
 * Drops every organization's Knowledge from the cache, requests still in
 * flight included, so nothing read for one session or organization can show
 * after the next one starts. Call it on every change of who is signed in or
 * which organization is active.
 */
export const resetKnowledgeCache = async (queryClient: QueryClient) => {
  await queryClient.cancelQueries({ queryKey: memberKnowledgeKeys.all() });
  queryClient.removeQueries({ queryKey: memberKnowledgeKeys.all() });
};
