import { useQuery } from "@tanstack/react-query";

import { sessionOptions } from "@/lib/auth-queries";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";

/**
 * `anonymous` is reserved for a session read that answered "no session". A
 * read that failed is `unavailable`, even with a member session still cached:
 * the reader's identity is unknown, so neither member-only UI nor an
 * anonymous-only path (such as the public feedback intake) may assume one.
 */
export type ClientAuthStatus =
  | { status: "checking"; isAuthenticated: false }
  | { status: "anonymous"; isAuthenticated: false }
  | { status: "unavailable"; isAuthenticated: false }
  | {
      status: "authenticated";
      isAuthenticated: true;
      user: AuthenticatedUser;
    };

/**
 * The visitor's session state. With `enabled: false` it reads only what the
 * cache already holds and never asks the server; a caller that needs the
 * state only on some pages passes it so the others stay request-free.
 */
export const useClientAuthStatus = ({
  enabled = true,
}: { enabled?: boolean } = {}): ClientAuthStatus => {
  const {
    data: sessionData,
    isError,
    isPending,
  } = useQuery({ ...sessionOptions, enabled });

  if (isPending) {
    return {
      status: "checking",
      isAuthenticated: false,
    };
  }

  if (isError) {
    return {
      status: "unavailable",
      isAuthenticated: false,
    };
  }

  const activeOrganizationId = sessionData?.session.activeOrganizationId;
  if (!activeOrganizationId) {
    return {
      status: "anonymous",
      isAuthenticated: false,
    };
  }

  return {
    status: "authenticated",
    isAuthenticated: true,
    user: {
      activeOrganizationId,
      email: sessionData.user.email,
      id: sessionData.session.userId,
      image: sessionData.user.image,
      name: sessionData.user.name || undefined,
      preferredName: sessionData.user.preferredName,
      timezoneId: sessionData.user.timezoneId,
      wordEditShortcut: sessionData.user.wordEditShortcut,
    },
  };
};
