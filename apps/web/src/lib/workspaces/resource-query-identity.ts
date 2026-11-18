import type { Query, QueryClient } from "@tanstack/react-query";
import { panic } from "better-result";

import {
  type captureSessionQueryOwner,
  hasCurrentAuthQueryOwner,
  isCurrentSessionQueryOwner,
  isObservedSessionQueryOwner,
} from "@/lib/account/auth-query-owner";

export type ResourceQueryOwner = ReturnType<typeof captureSessionQueryOwner>;

export type ResourceQueryScopeIdentity =
  | { type: "workspace"; workspaceId: string }
  | { type: "workspace-set"; workspaceIds: readonly string[] }
  | { type: "organization"; organizationId: string; userId?: string }
  | { type: "user"; userId: string }
  | { type: "current-session" };

export type ResourceRefreshContext = {
  readonly match?: "exact" | undefined;
  readonly owner?: ResourceQueryOwner;
  readonly query?: Query | undefined;
};

export const isIdentityOwnedResourceQuery = (query: Query): boolean => {
  const reads = query.meta?.resourceReads;
  return (
    reads !== undefined &&
    !("type" in reads) &&
    reads.scope.type !== "workspace" &&
    reads.scope.type !== "workspace-set"
  );
};

/** Eligibility is rechecked at the final fetch, including queued refreshes. */
export const canInvalidateResourceQuery = (
  queryClient: QueryClient,
  query: Query,
  context: ResourceRefreshContext,
): boolean => {
  if (context.query !== undefined && context.query !== query) {
    return false;
  }
  if (
    context.owner !== undefined &&
    !isObservedSessionQueryOwner(queryClient, context.owner)
  ) {
    return false;
  }
  if (!isIdentityOwnedResourceQuery(query)) {
    return true;
  }
  const reads = query.meta?.resourceReads;
  if (
    !reads ||
    "type" in reads ||
    context.match !== "exact" ||
    context.query !== query ||
    context.owner === undefined ||
    !isObservedSessionQueryOwner(queryClient, context.owner)
  ) {
    return false;
  }
  switch (reads.scope.type) {
    case "organization":
      return reads.scope.organizationId === context.owner.organizationId;
    case "user":
      return reads.scope.userId === context.owner.userId;
    case "current-session":
      return hasCurrentAuthQueryOwner(queryClient, query);
    case "workspace":
    case "workspace-set":
      return true;
    default: {
      reads.scope satisfies never;
      return panic("Unhandled resource query scope");
    }
  }
};

/** Same-organization foreign-user entries may become stale, but never fetch. */
export const canRefreshResourceQuery = (
  queryClient: QueryClient,
  query: Query,
  context: ResourceRefreshContext,
): boolean => {
  if (!canInvalidateResourceQuery(queryClient, query, context)) {
    return false;
  }
  return (
    matchesReaderUser(query, context) &&
    (!isIdentityOwnedResourceQuery(query) ||
      isCurrentSessionQueryOwner(queryClient, context.owner))
  );
};

const matchesReaderUser = (
  query: Query,
  context: ResourceRefreshContext,
): boolean => {
  const reads = query.meta?.resourceReads;
  return (
    !reads ||
    "type" in reads ||
    reads.scope.type !== "organization" ||
    reads.scope.userId === undefined ||
    reads.scope.userId === context.owner?.userId
  );
};

/** A known fact waits only for temporarily unconfirmed fetch authority. */
export const isResourceQueryAwaitingAuthority = (
  queryClient: QueryClient,
  query: Query,
  context: ResourceRefreshContext,
): boolean =>
  canInvalidateResourceQuery(queryClient, query, context) &&
  isIdentityOwnedResourceQuery(query) &&
  matchesReaderUser(query, context) &&
  !isCurrentSessionQueryOwner(queryClient, context.owner);

const legacyOwner = {};
const unspecifiedQuery = {};
const refreshIdentities = new WeakMap<
  object,
  WeakMap<object, Map<"exact" | undefined, object>>
>();

/** Stable deduplication identity without conflating equal IDs after a transition. */
export const resourceRefreshIdentity = (
  context: ResourceRefreshContext,
): object => {
  const owner = context.owner ?? legacyOwner;
  const query = context.query ?? unspecifiedQuery;
  let queries = refreshIdentities.get(owner);
  if (queries === undefined) {
    queries = new WeakMap();
    refreshIdentities.set(owner, queries);
  }
  let matches = queries.get(query);
  if (matches === undefined) {
    matches = new Map();
    queries.set(query, matches);
  }
  let identity = matches.get(context.match);
  if (identity === undefined) {
    identity = {};
    matches.set(context.match, identity);
  }
  return identity;
};
