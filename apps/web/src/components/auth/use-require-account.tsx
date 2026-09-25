import { useNavigate, useRouterState } from "@tanstack/react-router";

import {
  ACCOUNT_GATE_FOR_SESSION,
  ACCOUNT_GATE_OUTCOME,
} from "@/components/auth/require-account.logic";
import type { AccountGateOutcome } from "@/components/auth/require-account.logic";
import { usePublicSignInRequest } from "@/components/public-sign-in-request";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";
import { detached } from "@/lib/detached";

/**
 * Whether the act may go ahead. A member gets `allowed` and the caller
 * carries on unchanged; a visitor gets `asking` and the sign-in dialog; a
 * reader whose session has not been read yet gets `checking` and nothing
 * happens. Only `allowed` may reach an AI endpoint.
 */
type EnsureAccount = () => AccountGateOutcome;

/**
 * The one account gate on the public law surface.
 *
 * Every AI affordance is drawn for a visitor exactly as it is for a member,
 * and the account is asked for at the moment the visitor tries to create
 * something with one: the shell's sign-in dialog opens directly and returns
 * to this page. There is no intermediate prompt of its own;
 * `no-custom-account-modal` keeps it that way.
 */
export const useRequireAccount = (): EnsureAccount => {
  // The session itself, not the provider around it: the public shell mounts
  // `AuthenticatedUserProvider` only once the session read resolves, so
  // provider absence alone cannot tell a visitor from a member still loading.
  const authStatus = useClientAuthStatus();
  const requestSignIn = usePublicSignInRequest();
  const navigate = useNavigate();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });

  return () => {
    const outcome = ACCOUNT_GATE_FOR_SESSION[authStatus.status];
    if (outcome !== ACCOUNT_GATE_OUTCOME.asking) {
      return outcome;
    }
    // Outside the public shell there is no dialog to open, so the same round
    // trip is taken as a navigation.
    if (requestSignIn === null) {
      detached(
        navigate({ to: "/auth", search: { redirectTo: currentHref } }),
        "require-account.navigate-to-auth",
      );
      return outcome;
    }
    requestSignIn(currentHref);
    return outcome;
  };
};
