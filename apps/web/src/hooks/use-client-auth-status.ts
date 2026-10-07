import { useQueries, useQuery } from "@tanstack/react-query";
import { panic } from "better-result";

import { PROFESSIONAL_USE_STATUS } from "@stll/api-contract/professional-use";

import { professionalUseOptions, sessionOptions } from "@/lib/auth-queries";
import type { AuthenticatedUser } from "@/lib/authenticated-user-context";

/**
 * `anonymous` is reserved for a session read that answered "no session", or a
 * session that may not use the product yet: no organization, or an account
 * that has not accepted the professional-use statement (the API refuses its
 * member requests, so public pages serve it as a visitor). A read that failed
 * is `unavailable`, even with a member session still cached: the reader's
 * identity is unknown, so neither member-only UI nor an anonymous-only path
 * (such as the public feedback intake) may assume one.
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
  const memberUserId = sessionData?.session.activeOrganizationId
    ? sessionData.session.userId
    : undefined;
  // Read only for a member: a visitor's cache holds nothing of it.
  const [professionalUse] = useQueries({
    queries:
      memberUserId === undefined
        ? []
        : [{ ...professionalUseOptions(memberUserId), enabled }],
  });

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

  if (professionalUse === undefined || professionalUse.isPending) {
    return {
      status: "checking",
      isAuthenticated: false,
    };
  }

  if (professionalUse.isError) {
    return {
      status: "unavailable",
      isAuthenticated: false,
    };
  }

  switch (professionalUse.data.status) {
    case PROFESSIONAL_USE_STATUS.required:
      return {
        status: "anonymous",
        isAuthenticated: false,
      };
    case PROFESSIONAL_USE_STATUS.accepted:
      break;
    default:
      professionalUse.data satisfies never;
      return panic("Unhandled professional-use state");
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
