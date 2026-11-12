import { Button } from "@stll/ui/components/button";

import { AppHeader } from "@/components/app-header";
import { Notice } from "@/components/notice";
import type { Translate } from "@/components/panel";
import type { SignInState } from "@/hooks/use-outlook-auth";
import type { TranslationKey } from "@/i18n/types";
import type { SignInFailure } from "@/lib/oauth/errors";

type SignInPanelProps = {
  onSignIn: () => void;
  signInState: SignInState;
  t: Translate;
};

const FAILURE_MESSAGE = {
  cancelled: "signInCancelled",
  denied: "signInDenied",
  malformed: "signInFailedDescription",
  mismatched: "signInFailedDescription",
  token: "signInFailedDescription",
  unavailable: "signInFailedDescription",
  unsupported: "dialogOriginUnsupported",
} as const satisfies Record<SignInFailure, TranslationKey>;

export const SignInPanel = ({ onSignIn, signInState, t }: SignInPanelProps) => (
  <div className="min-h-dvh">
    <AppHeader subtitle={t("signInDescription")} title={t("signInTitle")} />
    <div className="flex flex-col gap-4 p-4">
      <Button
        className="w-full"
        loading={signInState.type === "signing-in"}
        onClick={onSignIn}
      >
        {t("signInCta")}
      </Button>
      {signInState.type === "error" ? (
        <Notice role="alert" title={t("signInFailed")} tone="risk">
          {t(FAILURE_MESSAGE[signInState.failure])}
        </Notice>
      ) : null}
    </div>
  </div>
);
