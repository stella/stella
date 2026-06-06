import { createContext, use } from "react";
import type { PropsWithChildren } from "react";

import { panic } from "better-result";

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

export function AuthenticatedUserProvider({
  children,
  user,
}: PropsWithChildren<{ user: AuthenticatedUser }>) {
  return (
    <AuthenticatedUserContext value={user}>{children}</AuthenticatedUserContext>
  );
}

export const useAuthenticatedUser = (): AuthenticatedUser => {
  const user = use(AuthenticatedUserContext);
  if (!user) {
    panic(
      "useAuthenticatedUser must be used within AuthenticatedUserProvider.",
    );
  }
  return user;
};
