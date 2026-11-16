import type { ReactNode } from "react";

import { Button } from "@stll/ui/components/button";
import { StellaWordmarkLatin } from "@stll/ui/stella-wordmark";
import { Text } from "@stll/ui/text";

import type { Translate } from "@/components/panel";
import type { SignInState } from "@/hooks/use-outlook-auth";
import type { TranslationKey } from "@/i18n/types";
import type { SignInFailure } from "@/lib/oauth/errors";

/** The terms every sign-in agrees to, as the web and mobile sign-ins link them. */
const TERMS_URL = "https://stll.app/terms/";

/** The web auth layout's backdrop: the page background, then blue toward the foot. */
const AUTH_BACKDROP =
  "linear-gradient(to bottom, var(--background) 40%, var(--auth-gradient-end))";

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

/**
 * Signed out: the stella sign-in every app shares (the web's auth layout,
 * apps/web/src/routes/auth/route.tsx, and the mobile sign-in,
 * apps/mobile/src/app/sign-in.tsx): the wordmark, the
 * light headline and caption over the auth backdrop, and the sign-in
 * button with the terms under it, at the pane's width.
 */
export const SignInPanel = ({ onSignIn, signInState, t }: SignInPanelProps) => (
  <main
    className="flex min-h-dvh flex-col px-6 pt-6 pb-6"
    style={{ background: AUTH_BACKDROP }}
  >
    <header>
      <StellaWordmarkLatin
        aria-label="stella"
        className="text-foreground h-6 w-auto"
        role="img"
      />
    </header>
    <div className="flex flex-1 flex-col justify-center gap-4 py-10">
      <h1>
        <Text className="text-balance" variant="display">
          {t("signInHeadline")}
        </Text>
      </h1>
      <Text className="text-pretty" variant="caption">
        {t("signInSubtitle")}
      </Text>
    </div>
    <div className="flex flex-col gap-4">
      {signInState.type === "error" ? (
        <Text aria-live="polite" role="alert" variant="error">
          {t(FAILURE_MESSAGE[signInState.failure])}
        </Text>
      ) : null}
      <Button
        className="w-full"
        loading={signInState.type === "signing-in"}
        onClick={onSignIn}
        size="lg"
      >
        {t("signInCta")}
      </Button>
      <Text variant="caption">
        {t.rich("signInTerms", {
          terms: (chunks: ReactNode) => (
            <a
              className="hover:text-foreground underline"
              href={TERMS_URL}
              rel="noreferrer"
              target="_blank"
            >
              {chunks}
            </a>
          ),
        })}
      </Text>
    </div>
  </main>
);
