import { useState } from "react";

import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  FileCheck2Icon,
  KeyRoundIcon,
  LockKeyholeIcon,
  MailCheckIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from "@stll/ui/components/input-otp";
import { Label } from "@stll/ui/components/label";
import { stellaToast } from "@stll/ui/components/toast";

import { StellaWordmark } from "@/components/stella-wordmark";
import { api } from "@/lib/api";
import { authClient, isTwoFactorRedirect } from "@/lib/auth";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { loadAuthContext } from "@/routes/-auth-context";

const exchangeInvitation = async (invitationSecret: string) =>
  unwrapEden(
    await api["share-spaces"].access.exchange.post({ invitationSecret }),
  );

export const Route = createFileRoute("/share/$invitationSecret")({
  beforeLoad: async ({ context, params }) => {
    const authContext = await loadAuthContext(context.queryClient);
    if (authContext.session) {
      const exchange = await exchangeInvitation(params.invitationSecret).catch(
        () => null,
      );
      if (exchange) {
        throw redirect({
          to: "/shared/$shareSpaceId",
          params: { shareSpaceId: exchange.shareSpaceId },
          replace: true,
        });
      }
    }
    return authContext;
  },
  head: () => ({
    meta: [
      { name: "robots", content: "noindex,nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: ShareAccessPage,
});

function ShareAccessPage() {
  const invitationSecret = Route.useParams({
    select: (params) => params.invitationSecret,
  });
  const signedInEmail = Route.useRouteContext({
    select: (context) => context.user?.email ?? null,
  });
  const t = useTranslations();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"email" | "otp">("email");
  const [pending, setPending] = useState(false);

  const finishExchange = async () => {
    const exchange = await exchangeInvitation(invitationSecret);
    await navigate({
      to: "/shared/$shareSpaceId",
      params: { shareSpaceId: exchange.shareSpaceId },
      replace: true,
    });
  };

  const requestOtp = async (isResend = false) => {
    setPending(true);
    try {
      unwrapEden(
        await api["share-spaces"].access["request-otp"].post({
          invitationSecret,
          email,
        }),
      );
      if (isResend) {
        setOtp("");
      }
      setStep("otp");
      if (isResend) {
        stellaToast.add({
          title: t("sharing.access.codeResent"),
          type: "success",
        });
      }
    } catch (error) {
      stellaToast.add({
        title: userErrorFromThrown(error, t("sharing.access.sendFailed")),
        type: "error",
      });
    } finally {
      setPending(false);
    }
  };

  const verifyOtp = async (completedOtp = otp) => {
    setPending(true);
    try {
      const { data, error } = await authClient.signIn.emailOtp({
        email,
        otp: completedOtp,
      });
      if (error) {
        throw toAuthClientError(error);
      }
      if (isTwoFactorRedirect(data)) {
        await navigate({
          to: "/auth/two-factor",
          search: { redirectTo: `/share/${invitationSecret}` },
        });
        return;
      }
      await finishExchange();
    } catch (error) {
      setOtp("");
      stellaToast.add({
        title: userErrorFromThrown(error, t("sharing.access.verifyFailed")),
        type: "error",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="bg-background relative flex min-h-dvh flex-col overflow-hidden">
      <div className="bg-primary/8 pointer-events-none absolute -start-32 -top-40 size-[34rem] rounded-full blur-3xl" />
      <div className="pointer-events-none absolute end-[-12rem] bottom-[-16rem] size-[36rem] rounded-full bg-[var(--option-emerald-bg)]/70 blur-3xl" />
      <header className="relative z-10 flex h-16 items-center justify-between px-6 sm:px-8">
        <StellaWordmark className="h-5 w-auto" />
        <div className="text-muted-foreground bg-background/80 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs shadow-xs backdrop-blur">
          <LockKeyholeIcon className="text-primary size-3.5" />
          {t("sharing.access.privateLink")}
        </div>
      </header>

      <div className="relative z-10 grid flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(26rem,0.8fr)]">
        <section className="hidden items-center justify-center p-12 lg:flex">
          <div className="max-w-lg">
            <div className="bg-primary text-primary-foreground shadow-primary/15 mb-7 flex size-14 items-center justify-center rounded-2xl shadow-lg">
              <ShieldCheckIcon className="size-7" />
            </div>
            <p className="text-primary mb-3 text-xs font-semibold tracking-[0.16em] uppercase">
              {t("sharing.access.eyebrow")}
            </p>
            <h1 className="font-heading text-4xl leading-tight font-semibold tracking-tight">
              {t("sharing.access.heroTitle")}
            </h1>
            <p className="text-muted-foreground mt-4 max-w-md text-base leading-relaxed">
              {t("sharing.access.heroDescription")}
            </p>
            <div className="mt-9 space-y-5">
              <TrustPoint
                description={t("sharing.access.trustIdentityDescription")}
                icon={MailCheckIcon}
                title={t("sharing.access.trustIdentity")}
              />
              <TrustPoint
                description={t("sharing.access.trustSnapshotDescription")}
                icon={FileCheck2Icon}
                title={t("sharing.access.trustSnapshot")}
              />
              <TrustPoint
                description={t("sharing.access.trustPrivacyDescription")}
                icon={KeyRoundIcon}
                title={t("sharing.access.trustPrivacy")}
              />
            </div>
          </div>
        </section>

        <section className="flex items-center justify-center p-5 sm:p-8 lg:justify-start">
          <Frame className="w-full max-w-md shadow-xl shadow-black/5">
            <FrameHeader className="px-6 pt-6 pb-5">
              <div className="mb-5 flex items-center gap-2">
                <div
                  className={`flex size-7 items-center justify-center rounded-full text-xs font-semibold ${
                    step === "email"
                      ? "bg-primary text-primary-foreground"
                      : "bg-[var(--option-emerald-bg)] text-[var(--option-emerald-fg)]"
                  }`}
                >
                  {step === "email" ? 1 : <CheckIcon className="size-3.5" />}
                </div>
                <div className="bg-border h-px flex-1" />
                <div
                  className={`flex size-7 items-center justify-center rounded-full text-xs font-semibold ${
                    step === "otp"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  2
                </div>
              </div>
              <div className="bg-primary/10 text-primary mb-3 flex size-10 items-center justify-center rounded-xl lg:hidden">
                <ShieldCheckIcon className="size-5" />
              </div>
              <FrameTitle className="font-heading text-xl">
                {step === "email"
                  ? t("sharing.access.secureDocument")
                  : t("sharing.access.checkInbox")}
              </FrameTitle>
              <FrameDescription className="mt-1 leading-relaxed">
                {step === "email"
                  ? t("sharing.access.verifyDescription")
                  : t("sharing.access.emailHint", { email })}
              </FrameDescription>
            </FrameHeader>
            <FramePanel className="p-6">
              {step === "email" ? (
                <form
                  className="flex flex-col gap-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    detached(requestOtp(), "ShareAccessPage.requestOtp");
                  }}
                >
                  {signedInEmail ? (
                    <div className="border-border bg-muted/35 rounded-lg border p-3 text-xs">
                      <p className="font-medium">
                        {t("sharing.access.signedInAs", {
                          email: signedInEmail,
                        })}
                      </p>
                      <p className="text-muted-foreground mt-1">
                        {t("sharing.access.accountSwitchHint")}
                      </p>
                    </div>
                  ) : null}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="share-email">
                      {t("sharing.access.email")}
                    </Label>
                    <Input
                      autoComplete="email"
                      autoFocus
                      id="share-email"
                      placeholder={t("sharing.access.emailPlaceholder")}
                      type="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                    />
                    <p className="text-muted-foreground text-xs">
                      {t("sharing.access.emailPrivacy")}
                    </p>
                  </div>
                  <Button
                    className="mt-1 w-full"
                    disabled={pending || email.trim().length === 0}
                    loading={pending}
                    type="submit"
                  >
                    {t("sharing.access.sendCode")}
                    <ArrowRightIcon />
                  </Button>
                </form>
              ) : (
                <form
                  className="flex flex-col gap-5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    detached(verifyOtp(), "ShareAccessPage.verifyOtp");
                  }}
                >
                  <div className="flex justify-center py-2">
                    <InputOTP
                      autoFocus
                      disabled={pending}
                      maxLength={6}
                      onChange={setOtp}
                      onComplete={(code: string) => {
                        setOtp(code);
                        detached(
                          verifyOtp(code),
                          "ShareAccessPage.verifyCompletedOtp",
                        );
                      }}
                      value={otp}
                    >
                      <InputOTPGroup>
                        {[0, 1, 2, 3, 4, 5].map((index) => (
                          <InputOTPSlot
                            className="h-11 w-11 text-base"
                            index={index}
                            key={index}
                          />
                        ))}
                      </InputOTPGroup>
                    </InputOTP>
                  </div>
                  <Button
                    className="w-full"
                    disabled={pending || otp.length !== 6}
                    loading={pending}
                    type="submit"
                  >
                    <LockKeyholeIcon />
                    {t("sharing.access.open")}
                  </Button>
                  <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
                    <Button
                      disabled={pending}
                      onClick={() =>
                        detached(requestOtp(true), "ShareAccessPage.resend")
                      }
                      size="sm"
                      type="button"
                      variant="link"
                    >
                      {t("sharing.access.resendCode")}
                    </Button>
                    <span className="text-muted-foreground text-xs" aria-hidden>
                      ·
                    </span>
                    <Button
                      disabled={pending}
                      onClick={() => {
                        setOtp("");
                        setStep("email");
                      }}
                      size="sm"
                      type="button"
                      variant="link"
                    >
                      <ArrowLeftIcon />
                      {t("sharing.access.differentEmail")}
                    </Button>
                  </div>
                </form>
              )}
            </FramePanel>
          </Frame>
        </section>
      </div>

      <footer className="text-muted-foreground relative z-10 flex items-center justify-center gap-2 px-6 py-5 text-center text-xs">
        <SparklesIcon className="text-primary size-3.5" />
        {t("sharing.access.footer")}
      </footer>
    </main>
  );
}

const TrustPoint = ({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: typeof ShieldCheckIcon;
  title: string;
}) => (
  <div className="flex items-start gap-3.5">
    <div className="bg-background text-primary flex size-9 shrink-0 items-center justify-center rounded-lg border shadow-xs">
      <Icon className="size-4" />
    </div>
    <div>
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
        {description}
      </p>
    </div>
  </div>
);
