import { useState } from "react";

import { useForm, useStore } from "@tanstack/react-form";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/components/button";
import { Field, FieldError } from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import { Input } from "@stll/ui/components/input";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { env } from "@/env";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient, HTTP_TOO_MANY_REQUESTS } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { pageTitle } from "@/lib/page-title";
import { isAcceptInvitationRedirect, redirectToSchema } from "@/lib/redirect";
import { sanitizeHref } from "@/lib/sanitize-href";
import { emailSchema, toFormErrors } from "@/lib/schema";

const searchSchema = v.strictObject({
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/")({
  validateSearch: searchSchema,
  beforeLoad: ({ context, search }) => {
    if (context.session) {
      throw redirect({
        to: "/auth/organization",
        search: { redirectTo: search.redirectTo },
        replace: true,
      });
    }
  },
  head: () => ({
    meta: [{ title: pageTitle("auth.signIn") }],
  }),
  component: LoginOrSignup,
});

const formSchema = v.strictObject({
  email: emailSchema(),
});

const hasSocialProviders = env.VITE_AUTH_GOOGLE || env.VITE_AUTH_MICROSOFT;
const termsUrl = sanitizeHref(env.VITE_TERMS_URL) ?? "/terms";

const renderTermsLink = (chunks: React.ReactNode) => (
  <a
    className="hover:text-foreground underline"
    href={termsUrl}
    rel="noopener"
    target="_blank"
  >
    {chunks}
  </a>
);

function LoginOrSignup() {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = Route.useNavigate();
  const redirectTo = Route.useSearch({ select: (s) => s.redirectTo });
  const [socialLoading, setSocialLoading] = useState<
    "google" | "microsoft" | null
  >(null);
  const lastMethod = authClient.getLastUsedLoginMethod();

  const handleSocialSignIn = async (provider: "google" | "microsoft") => {
    setSocialLoading(provider);
    // Route the OAuth redirect through /auth/organization so the
    // org-selection step threads `redirectTo` to the final page,
    // matching the email OTP flow.
    const callbackURL = new URL("/auth/organization", window.location.origin);
    if (redirectTo) {
      callbackURL.searchParams.set("redirectTo", redirectTo);
    }
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: callbackURL.toString(),
    });

    if (!error) {
      // Navigation to the OAuth provider is in progress; leave the
      // spinner on so users get feedback until the browser unloads.
      return;
    }

    analytics.captureError(toAuthClientError(error));
    if (error.status !== HTTP_TOO_MANY_REQUESTS) {
      stellaToast.add({
        title: error.message ?? t("errors.actionFailed"),
        type: "error",
      });
    }
    setSocialLoading(null);
  };

  const form = useForm({
    defaultValues: { email: "" },
    validators: {
      onDynamic: formSchema,
    },
    onSubmit: async ({ value }) => {
      const parseResult = v.safeParse(formSchema, value);
      if (!parseResult.success) {
        return;
      }
      const parsedValue = parseResult.output;
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: parsedValue.email,
        type: "sign-in",
      });

      if (error) {
        analytics.captureError(toAuthClientError(error));
        if (error.status !== HTTP_TOO_MANY_REQUESTS) {
          stellaToast.add({
            title: error.message ?? t("errors.actionFailed"),
            type: "error",
          });
        }
        return;
      }

      if (import.meta.env.DEV) {
        // Best-effort convenience: surface the OTP in a toast so the
        // dev doesn't have to hop to the API logs. Any failure (slow
        // endpoint, dev API down, timeout) must not block navigation.
        const probe = await Result.tryPromise(async () => {
          const url = new URL("/dev-public/last-otp", env.VITE_API_URL);
          url.searchParams.set("email", parsedValue.email);
          const response = await fetch(url, {
            credentials: "include",
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            return null;
          }
          const parsed = v.safeParse(
            v.object({ otp: v.string() }),
            await response.json(),
          );
          return parsed.success ? parsed.output.otp : null;
        });
        if (Result.isOk(probe) && probe.value !== null) {
          stellaToast.add({
            title: `Dev OTP: ${probe.value}`,
            type: "info",
            // Dev-only convenience toast — once the user reads the
            // code there's nothing left to do with it. Auto-dismiss
            // so it doesn't pile up across sign-in attempts.
            timeout: 8000,
          });
        }
      }

      await navigate({
        to: "/auth/otp",
        search: { email: parsedValue.email, redirectTo },
      });
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

  return (
    <div className="flex w-full max-w-md flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h2 className="text-foreground text-[2rem] leading-[1.15] font-light tracking-tight">
          {t("auth.signIn")}
        </h2>
        {isAcceptInvitationRedirect(redirectTo) && (
          <p className="text-muted-foreground text-sm">
            {t("auth.signInBeforeInvitation")}
          </p>
        )}
      </div>

      {hasSocialProviders && (
        <div className="flex flex-col gap-3">
          {env.VITE_AUTH_GOOGLE && (
            <SocialButton
              icon={<GoogleIcon />}
              label={t("auth.continueWithGoogle")}
              lastUsedLabel={t("auth.lastUsed")}
              lastUsed={lastMethod === "google"}
              loading={socialLoading === "google"}
              disabled={socialLoading !== null}
              onClick={() => {
                handleSocialSignIn("google").catch((error: unknown) => {
                  setSocialLoading(null);
                  analytics.captureError(
                    error instanceof Error ? error : new Error(String(error)),
                  );
                });
              }}
            />
          )}
          {env.VITE_AUTH_MICROSOFT && (
            <SocialButton
              icon={<MicrosoftIcon />}
              label={t("auth.continueWithMicrosoft")}
              lastUsedLabel={t("auth.lastUsed")}
              lastUsed={lastMethod === "microsoft"}
              loading={socialLoading === "microsoft"}
              disabled={socialLoading !== null}
              onClick={() => {
                handleSocialSignIn("microsoft").catch((error: unknown) => {
                  setSocialLoading(null);
                  analytics.captureError(
                    error instanceof Error ? error : new Error(String(error)),
                  );
                });
              }}
            />
          )}
        </div>
      )}

      {hasSocialProviders && (
        <div className="flex items-center gap-3">
          <div className="bg-border h-px flex-1" />
          <span className="text-muted-foreground text-xs">
            {t("auth.orSignInWithEmail")}
          </span>
          <div className="bg-border h-px flex-1" />
        </div>
      )}

      <Form
        errors={formErrors}
        onSubmit={(e) => {
          e.preventDefault();
          // eslint-disable-next-line typescript/no-floating-promises
          form.handleSubmit();
        }}
      >
        <form.Field name="email">
          {(field) => (
            <Field name={field.name}>
              <Input
                autoFocus={!hasSocialProviders}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={t("auth.emailPlaceholder")}
                size="lg"
                type="email"
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>
        <form.Subscribe
          selector={(s) => ({
            isSubmitting: s.isSubmitting,
            canSubmit: s.canSubmit,
            email: s.values.email,
          })}
        >
          {({ isSubmitting, canSubmit, email }) => (
            <Button
              className="w-full"
              disabled={!canSubmit || email.trim().length === 0}
              loading={isSubmitting}
              type="submit"
            >
              {t("auth.continueWithEmail")}
            </Button>
          )}
        </form.Subscribe>
      </Form>
      <p className="text-foreground-muted text-xs">
        {t.rich("onboarding.termsNotice", {
          terms: renderTermsLink,
        })}
      </p>
    </div>
  );
}

function SocialButton({
  icon,
  label,
  lastUsedLabel,
  lastUsed,
  loading,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  lastUsedLabel: string;
  lastUsed: boolean;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="relative">
      <Button
        className={cn(
          "w-full min-w-0 shrink max-sm:h-auto max-sm:min-h-10 max-sm:px-2 max-sm:py-2 max-sm:text-[0.95rem] max-sm:leading-tight max-sm:whitespace-normal sm:whitespace-nowrap",
          lastUsed && "border-primary/40 shadow-primary/8 shadow-sm",
        )}
        disabled={disabled}
        loading={loading}
        onClick={onClick}
        size="lg"
        variant="outline"
      >
        {icon}
        <span className="min-w-0 text-center">{label}</span>
      </Button>
      {lastUsed && (
        <span className="bg-primary text-primary-foreground absolute end-3 -top-2 rounded-full px-2 py-0.5 text-[10px] font-medium">
          {lastUsedLabel}
        </span>
      )}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      viewBox="0 0 21 21"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#F25022" height="9" width="9" x="1" y="1" />
      <rect fill="#7FBA00" height="9" width="9" x="11" y="1" />
      <rect fill="#00A4EF" height="9" width="9" x="1" y="11" />
      <rect fill="#FFB900" height="9" width="9" x="11" y="11" />
    </svg>
  );
}
