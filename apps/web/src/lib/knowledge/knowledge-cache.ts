import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

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

const startsWith = (key: QueryKey, prefix: QueryKey) =>
  prefix.every((part, index) => key[index] === part);

/**
 * Drops everything read for the previous visitor once the page moves on to
 * another one (a different user or organization, or nobody), requests still
 * in flight included. Only `keep` survives: what says who is visiting. Run it
 * while neither visitor's frame is on screen, so nothing of the previous one
 * renders again and nothing of the next one is dropped.
 */
export const resetVisitorCache = async (
  queryClient: QueryClient,
  keep: readonly QueryKey[],
) => {
  const previousVisitor = (query: Query) =>
    !keep.some((prefix) => startsWith(query.queryKey, prefix));
  await queryClient.cancelQueries({ predicate: previousVisitor });
  queryClient.removeQueries({ predicate: previousVisitor });
};
