import { Button } from "@stll/ui/components/button";

import { AppHeader } from "@/components/app-header";
import { Notice } from "@/components/notice";
import type { Translate } from "@/components/panel";

export type SignInState =
  | { type: "idle" }
  | { type: "signing-in" }
  | { message: string; type: "error" };

type SignInPanelProps = {
  onSignIn: () => void;
  signInState: SignInState;
  t: Translate;
};

export const SignInPanel = ({ onSignIn, signInState, t }: SignInPanelProps) => (
  <div className="min-h-screen">
    <AppHeader subtitle={t("handoffDescription")} title={t("handoffTitle")} />
    <div className="flex flex-col gap-4 p-4">
      <Button
        className="w-full"
        loading={signInState.type === "signing-in"}
        onClick={onSignIn}
      >
        {t("handoffSignInCta")}
      </Button>
      {signInState.type === "error" && (
        <Notice title={t("saveFailed")} tone="risk">
          {signInState.message}
        </Notice>
      )}
    </div>
  </div>
);
