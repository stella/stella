import { useEffect, useState } from "react";

import type { AuthenticatedUser } from "@/lib/authenticated-user-context";

type ClientAuthStatus =
  | { status: "checking"; isAuthenticated: false }
  | { status: "anonymous"; isAuthenticated: false }
  | {
      status: "authenticated";
      isAuthenticated: true;
      user: AuthenticatedUser;
    };

export const useClientAuthStatus = (): ClientAuthStatus => {
  const [authStatus, setAuthStatus] = useState<ClientAuthStatus>({
    status: "checking",
    isAuthenticated: false,
  });

  useEffect(() => {
    void (async () => {
      const { authClient } = await import("@/lib/auth");
      const result = await authClient.getSession();

      const sessionData = result.data;
      const activeOrganizationId = sessionData?.session.activeOrganizationId;
      if (
        sessionData === null ||
        activeOrganizationId === undefined ||
        activeOrganizationId === null
      ) {
        setAuthStatus({ status: "anonymous", isAuthenticated: false });
        return;
      }

      setAuthStatus({
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
      });
    })().catch(() => {
      setAuthStatus({ status: "anonymous", isAuthenticated: false });
    });
  }, []);

  return authStatus;
};
