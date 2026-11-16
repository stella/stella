import { CancelledError, hashKey } from "@tanstack/react-query";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

import { rootKeys, sessionOptions } from "@/lib/auth-query-options";

type AuthQueryOwner = {
  userId: string | null;
  organizationId: string | null;
};

type AuthQueryBinding = {
  owner: AuthQueryOwner;
  signal: AbortSignal;
};

const owners = new WeakMap<QueryClient, AuthQueryOwner>();
const bindings = new WeakMap<Query, AuthQueryBinding>();
const cacheOwners = new WeakMap<Query, AuthQueryOwner>();

/** Called by the session cache guard on successful session observations.
 * Same-owner refreshes retain their snapshot; leaving and returning does not. */
export const observeAuthQueryOwner = (queryClient: QueryClient): void => {
  const session = queryClient.getQueryState(sessionOptions.queryKey);
  if (session?.status !== "success") {
    return;
  }
  const userId = session.data?.user.id ?? null;
  const organizationId = session.data?.session.activeOrganizationId ?? null;
  const previous = owners.get(queryClient);
  if (
    previous?.userId === userId &&
    previous.organizationId === organizationId
  ) {
    return;
  }
  owners.set(queryClient, {
    userId,
    organizationId,
  });
};

export const isAuthBootstrapQuery = (query: Query): boolean =>
  query.queryHash === hashKey(rootKeys.role) ||
  query.queryHash === hashKey(rootKeys.activeMember);

/** A bootstrap cache value is reusable only for the owner that requested it. */
export const hasCurrentAuthQueryOwner = (
  queryClient: QueryClient,
  query: Query,
): boolean => {
  const binding = bindings.get(query);
  return (
    (cacheOwners.has(query) &&
      cacheOwners.get(query) === owners.get(queryClient)) ||
    (query.state.data === undefined &&
      binding !== undefined &&
      !binding.signal.aborted &&
      binding.owner === owners.get(queryClient))
  );
};

/** Bind before importing the SDK or invoking its request. Completion rejects
 * transports that ignore cancellation and replaced Query objects. */
export const bindAuthQueryOwner = ({
  queryClient,
  queryKey,
  signal,
}: {
  queryClient: QueryClient;
  queryKey: QueryKey;
  signal: AbortSignal;
}): { assertCurrent: () => void; accept: () => void } => {
  observeAuthQueryOwner(queryClient);
  const owner = owners.get(queryClient);
  const session = queryClient.getQueryState(sessionOptions.queryKey);
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (
    session?.status !== "success" ||
    owner === undefined ||
    owner.userId === null ||
    owner.organizationId === null ||
    query === undefined ||
    signal.aborted
  ) {
    throw new CancelledError({ revert: false });
  }
  const binding = { owner, signal };
  bindings.set(query, binding);
  const assertCurrent = () => {
    observeAuthQueryOwner(queryClient);
    if (
      queryClient.getQueryState(sessionOptions.queryKey)?.status !==
        "success" ||
      signal.aborted ||
      owners.get(queryClient) !== owner ||
      bindings.get(query) !== binding ||
      queryClient.getQueryCache().find({ queryKey, exact: true }) !== query
    ) {
      throw new CancelledError({ revert: false });
    }
  };
  return {
    assertCurrent,
    accept: () => {
      assertCurrent();
      cacheOwners.set(query, owner);
    },
  };
};
