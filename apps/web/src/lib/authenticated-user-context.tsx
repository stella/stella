import { createContext, use } from "react";
import type { PropsWithChildren } from "react";

import { useRequiredRouteProvider } from "@/components/route-provider-scope/route-provider-scope";
import { PROVIDER_SCOPE } from "@/routes/-app-frame-scope";

export type AuthenticatedUser = {
  activeOrganizationId: string;
  email: string;
  id: string;
  image: string | null | undefined;
  name: string | undefined;
  preferredName: string | null | undefined;
  timezoneId: string;
  wordEditShortcut: string | null | undefined;
};

const AuthenticatedUserContext = createContext<AuthenticatedUser | null>(null);

export const AuthenticatedUserProvider = ({
  children,
  user,
}: PropsWithChildren<{ user: AuthenticatedUser }>) => (
  <AuthenticatedUserContext value={user}>{children}</AuthenticatedUserContext>
);

export const useAuthenticatedUser = (): AuthenticatedUser =>
  useRequiredRouteProvider({
    context: AuthenticatedUserContext,
    scope: PROVIDER_SCOPE.auth,
    missingMessage:
      "useAuthenticatedUser must be used within AuthenticatedUserProvider.",
  });

/**
 * Like useAuthenticatedUser, but returns null outside the provider.
 * For account-bound garnish on surfaces that anonymous visitors can
 * reach (public law pages, pre-signup AI features): render without the
 * account data instead of requiring the provider.
 */
export const useMaybeAuthenticatedUser = (): AuthenticatedUser | null =>
  use(AuthenticatedUserContext);
