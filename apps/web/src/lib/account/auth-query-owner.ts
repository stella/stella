import { CancelledError, hashKey } from "@tanstack/react-query";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import { Result } from "better-result";

import { rootKeys, sessionOptions } from "@/lib/auth-query-options";

type AuthQueryOwner = {
  readonly userId: string | null;
  readonly organizationId: string | null;
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
export const observeAuthQueryOwner = (
  queryClient: QueryClient,
): AuthQueryOwner | undefined => {
  const session = queryClient.getQueryState(sessionOptions.queryKey);
  if (session?.status !== "success") {
    return owners.get(queryClient);
  }
  const userId = session.data?.user.id ?? null;
  const organizationId = session.data?.session.activeOrganizationId ?? null;
  const previous = owners.get(queryClient);
  if (
    previous?.userId === userId &&
    previous.organizationId === organizationId
  ) {
    return previous;
  }
  const owner = {
    userId,
    organizationId,
  };
  owners.set(queryClient, owner);
  return owner;
};

/** Capture before starting work. An absent or failed session cannot gain
 * ownership from a later successful read. */
export const captureSessionQueryOwner = (queryClient: QueryClient) => {
  const owner = observeAuthQueryOwner(queryClient);
  return queryClient.getQueryState(sessionOptions.queryKey)?.status ===
    "success" &&
    owner !== undefined &&
    owner.userId !== null
    ? owner
    : undefined;
};

/** Lifecycle identity survives an unconfirmed read, but not an observed owner change. */
export const isObservedSessionQueryOwner = (
  queryClient: QueryClient,
  owner: ReturnType<typeof captureSessionQueryOwner>,
): owner is NonNullable<ReturnType<typeof captureSessionQueryOwner>> =>
  owner !== undefined && observeAuthQueryOwner(queryClient) === owner;

export const isCurrentSessionQueryOwner = (
  queryClient: QueryClient,
  owner: ReturnType<typeof captureSessionQueryOwner>,
): boolean =>
  owner !== undefined && captureSessionQueryOwner(queryClient) === owner;

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
}): Result<
  {
    assertCurrent: () => Result<void, CancelledError>;
    accept: () => Result<void, CancelledError>;
  },
  CancelledError
> => {
  const owner = captureSessionQueryOwner(queryClient);
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (owner === undefined) {
    return Result.err(new CancelledError({ revert: false }));
  }
  if (owner.organizationId === null || query === undefined || signal.aborted) {
    return Result.err(new CancelledError({ revert: false }));
  }
  const binding = { owner, signal };
  bindings.set(query, binding);
  const assertCurrent = () => {
    if (
      !isCurrentSessionQueryOwner(queryClient, owner) ||
      signal.aborted ||
      bindings.get(query) !== binding ||
      queryClient.getQueryCache().find({ queryKey, exact: true }) !== query
    ) {
      return Result.err(new CancelledError({ revert: false }));
    }
    return Result.ok(undefined);
  };
  return Result.ok({
    assertCurrent,
    accept: () => {
      const current = assertCurrent();
      if (current.isErr()) {
        return current;
      }
      cacheOwners.set(query, owner);
      return Result.ok(undefined);
    },
  });
};
