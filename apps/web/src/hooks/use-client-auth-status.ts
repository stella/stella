import { useQuery } from "@tanstack/react-query";

import type { AuthenticatedUser } from "@/lib/authenticated-user-context";
import { sessionOptions } from "@/routes/-queries";

type ClientAuthStatus =
  | { status: "checking"; isAuthenticated: false }
  | { status: "anonymous"; isAuthenticated: false }
  | {
      status: "authenticated";
      isAuthenticated: true;
      user: AuthenticatedUser;
    };

export const useClientAuthStatus = (): ClientAuthStatus => {
  const { data: sessionData, isError, isPending } = useQuery(sessionOptions);

  if (isPending) {
    return {
      status: "checking",
      isAuthenticated: false,
    };
  }

  const activeOrganizationId = sessionData?.session.activeOrganizationId;
  if (isError || sessionData === null || !activeOrganizationId) {
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
      isSystemAdmin: sessionData.user.isSystemAdmin ?? false,
      name: sessionData.user.name || undefined,
      preferredName: sessionData.user.preferredName,
      timezoneId: sessionData.user.timezoneId,
      wordEditShortcut: sessionData.user.wordEditShortcut,
    },
  };
};
