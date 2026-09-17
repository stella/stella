import { useState } from "react";
import type { ReactNode } from "react";

import { Link, useRouterState } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";

import {
  ACCOUNT_GATE_FOR_SESSION,
  ACCOUNT_GATE_OUTCOME,
  ACCOUNT_INTENT_TITLE_KEYS,
} from "@/components/auth/require-account.logic";
import type {
  AccountGateOutcome,
  AccountIntent,
} from "@/components/auth/require-account.logic";
import { usePublicSignInRequest } from "@/components/public-sign-in-request";
import { useClientAuthStatus } from "@/hooks/use-client-auth-status";

type RequireAccount = {
  /**
   * Whether the act may go ahead. A member gets `allowed` and the caller
   * carries on unchanged; a visitor gets the dialog and `asking`; a reader
   * whose session has not been read yet gets `checking` and nothing happens.
   * Only `allowed` may reach an AI endpoint.
   */
  ensureAccount: (intent: AccountIntent) => AccountGateOutcome;
  /** Render once inside the caller's tree; nothing is drawn until a gate trips. */
  accountDialog: ReactNode;
};

/**
 * The one account gate on the public law surface.
 *
 * Every AI affordance is drawn for a visitor exactly as it is for a member —
 * the composer over the reader, the headnote generator, the research
 * questions — and the account is asked for at the moment the visitor tries to
 * create something with one. The dialog names that act, then hands over to the
 * shell's existing sign-in round trip, which returns to this page.
 */
export const useRequireAccount = (): RequireAccount => {
  // The session itself, not the provider around it: the public shell mounts
  // `AuthenticatedUserProvider` only once the session read resolves, so
  // provider absence alone cannot tell a visitor from a member still loading.
  const authStatus = useClientAuthStatus();
  const [intent, setIntent] = useState<AccountIntent | null>(null);

  return {
    ensureAccount: (requested: AccountIntent): AccountGateOutcome => {
      const outcome = ACCOUNT_GATE_FOR_SESSION[authStatus.status];
      if (outcome === ACCOUNT_GATE_OUTCOME.asking) {
        setIntent(requested);
      }
      return outcome;
    },
    accountDialog: (
      <RequireAccountDialog
        intent={intent}
        onClose={() => {
          setIntent(null);
        }}
      />
    ),
  };
};

/**
 * What the gate says: the act the visitor started, and the one way on. Closed
 * — `intent` null — it draws nothing.
 */
const RequireAccountDialog = ({
  intent,
  onClose,
}: {
  intent: AccountIntent | null;
  onClose: () => void;
}) => {
  const t = useTranslations();
  const requestSignIn = usePublicSignInRequest();
  const currentHref = useRouterState({
    select: (state) => state.location.href,
  });

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={intent !== null}
    >
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {intent === null ? "" : t(ACCOUNT_INTENT_TITLE_KEYS[intent])}
          </DialogTitle>
          <DialogDescription>
            {t("auth.requireAccount.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          {/* Outside the public shell there is no dialog to hand over to, so
              the same round trip is taken as a navigation. */}
          {requestSignIn === null ? (
            <Button
              render={<Link search={{ redirectTo: currentHref }} to="/auth" />}
            >
              {t("auth.createFreeAccount")}
            </Button>
          ) : (
            <Button
              onClick={() => {
                onClose();
                requestSignIn(currentHref);
              }}
            >
              {t("auth.createFreeAccount")}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
