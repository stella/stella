import { useState } from "react";
import type { ReactNode } from "react";

import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { Input } from "@stll/ui/input";

import { socialProviderName } from "@/components/auth/access-reset.logic";
import type { SocialProvider } from "@/components/auth/access-reset.logic";
import { OTPPanel } from "@/components/auth/otp-panel";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import { afterSignInNavigation } from "@/lib/redirect";
import { emailSchema } from "@/lib/schema";

const renderProvider = (chunks: ReactNode) => (
  <BidiText direction="ltr">{chunks}</BidiText>
);

type RecoveryStep =
  | { type: "email" }
  | { type: "otp"; email: string }
  | { type: "connect"; provider: SocialProvider };

export const SocialRecoveryPanel = ({
  error,
  redirectTo,
  linkProvider,
  signedIn,
  hint,
}: {
  error?: string;
  redirectTo: string;
  linkProvider?: SocialProvider;
  signedIn: boolean;
  hint: { method: SocialProvider | null; provider: SocialProvider | null };
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  // Keep the consumed hint through session invalidation and the proof step.
  const [provider] = useState(hint.provider);
  const [method] = useState(hint.method);
  const [step, setStep] = useState<RecoveryStep>(
    signedIn && linkProvider
      ? { type: "connect", provider: linkProvider }
      : { type: "email" },
  );
  const [email, setEmail] = useState("");
  const finish = async () => await navigate(afterSignInNavigation(redirectTo));
  const onError = (cause: unknown) => {
    analytics.captureError(cause);
    notifyUserError(cause, t("errors.actionFailed"));
  };
  const sendCode = useMutation({
    mutationFn: async () => {
      const parsed = v.parse(emailSchema(), email);
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: parsed,
        type: "sign-in",
      });
      if (result.error) {
        const cause = toAuthClientError(result.error);
        throw cause;
      }
      setStep({ type: "otp", email: parsed });
    },
    onError,
  });
  const connect = useMutation({
    mutationFn: async (selectedProvider: SocialProvider) => {
      const callback = new URL("/auth/organization", window.location.origin);
      callback.searchParams.set("redirectTo", redirectTo);
      const result = await authClient.linkSocial({
        provider: selectedProvider,
        callbackURL: callback.toString(),
      });
      if (result.error) {
        const cause = toAuthClientError(result.error);
        throw cause;
      }
    },
    onError,
  });
  const handleVerified = async () => {
    if (provider === null) {
      await finish();
      return;
    }
    setStep({ type: "connect", provider });
  };

  if (error === "account_not_linked" && step.type === "otp") {
    return (
      <OTPPanel
        email={step.email}
        redirectTo={redirectTo}
        linkProvider={provider ?? undefined}
        onUseDifferentEmail={() => {
          setStep({ type: "email" });
          setEmail("");
        }}
        onVerified={handleVerified}
      />
    );
  }

  if (error === "account_not_linked" && step.type === "connect") {
    return (
      <Frame className="w-full max-w-sm">
        <FrameHeader>
          <FrameTitle>
            {t.rich("auth.socialLink.connect", {
              identity: renderProvider,
              provider: socialProviderName(step.provider),
            })}
          </FrameTitle>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-3">
          <Button
            className="w-full"
            loading={connect.isPending}
            disabled={connect.isPending}
            onClick={() => connect.mutate(step.provider)}
          >
            {t.rich("auth.socialLink.connectButton", {
              identity: renderProvider,
              provider: socialProviderName(step.provider),
            })}
          </Button>
          <Button
            variant="ghost"
            disabled={connect.isPending}
            onClick={() => detached(finish(), "social-link.skip")}
          >
            {t("auth.socialLink.skip")}
          </Button>
        </FramePanel>
      </Frame>
    );
  }

  const description = (() => {
    if (error !== "account_not_linked") {
      return t("auth.error.generic");
    }
    if (!method) {
      return t("auth.socialLink.emailProof");
    }
    return t.rich("auth.socialLink.methodHint", {
      identity: renderProvider,
      method: socialProviderName(method),
    });
  })();

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>
          {error === "account_not_linked"
            ? t("auth.signIn")
            : t("auth.error.title")}
        </FrameTitle>
        <FrameDescription>{description}</FrameDescription>
      </FrameHeader>
      <FramePanel>
        {error === "account_not_linked" ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              sendCode.mutate();
            }}
          >
            <Input
              aria-label={t("common.email")}
              autoComplete="email"
              autoFocus
              dir="ltr"
              type="email"
              required
              placeholder={t("auth.emailPlaceholder")}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={sendCode.isPending}
            />
            <Button
              type="submit"
              className="w-full"
              loading={sendCode.isPending}
              disabled={
                sendCode.isPending || !v.safeParse(emailSchema(), email).success
              }
            >
              {t("auth.continueWithEmail")}
            </Button>
          </form>
        ) : (
          <Button
            className="w-full"
            onClick={() =>
              detached(
                navigate({ to: "/auth", search: { redirectTo } }),
                "auth-error.navigate",
              )
            }
          >
            {t("common.tryAgain")}
          </Button>
        )}
      </FramePanel>
    </Frame>
  );
};
