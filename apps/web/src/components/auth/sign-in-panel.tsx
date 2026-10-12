import { useState } from "react";
import type { ReactNode } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD,
  PROFESSIONAL_USE_STATEMENT_VERSION,
} from "@stll/api-contract/professional-use";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { fetchWithTimeout } from "@stll/fetch";
import { Button } from "@stll/ui/button";
import { Field, FieldError } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { TextSeparator } from "@stll/ui/separator";
import { cn } from "@stll/ui/utils";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { env } from "@/env";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import { browserAuthBaseUrl } from "@/lib/api-url";
import { authCapabilitiesOptions } from "@/lib/auth-capabilities";
import { authClient, HTTP_TOO_MANY_REQUESTS } from "@/lib/auth-client";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import { isAcceptInvitationRedirect } from "@/lib/redirect";
import { schemaFormOptions, emailSchema, toFormErrors } from "@/lib/schema";
import { useQueryView } from "@/lib/use-query-view";

import {
  LastUsedSignInFrame,
  readLastUsedLoginMethod,
} from "./last-used-sign-in";
import {
  EmailCredentialField,
  getOrganizationCallbackUrl,
  PasswordSignInForm,
  SecretCredentialField,
} from "./password-sign-in-form";
import { PasswordSignInOption } from "./password-sign-in-option";
import {
  resolveLastUsedSignInMethod,
  resolveSignInOptions,
  SIGN_IN_METHOD,
  signInMethodVariant,
} from "./sign-in-panel.logic";
import type { AuthCapabilities, SignInMethod } from "./sign-in-panel.logic";

type SignInPanelProps = {
  className?: string;
  redirectTo: string;
  showHeading?: boolean;
  onOtpSent?: (payload: { email: string; redirectTo: string }) => void;
};

const formSchema = v.strictObject({
  email: emailSchema(),
});

const bootstrapFormSchema = v.strictObject({
  email: emailSchema(),
  password: v.string(),
  bootstrapToken: v.pipe(v.string(), v.trim()),
});

const authErrorResponseSchema = v.object({
  message: v.optional(v.string()),
});

const BETTER_AUTH_SIGN_UP_EMAIL_PATH = "/api/auth/sign-up/email";
const termsUrl = sanitizeHref(env.VITE_TERMS_URL) ?? "/terms";
const renderTermsLink = (chunks: ReactNode) => (
  <a
    className="hover:text-foreground underline"
    href={sanitizeHref(termsUrl)}
    rel="noreferrer"
    target="_blank"
  >
    {chunks}
  </a>
);

const SignInOptionsPanel = ({
  className,
  redirectTo,
  showHeading = true,
  onOtpSent,
  authCapabilities,
}: SignInPanelProps & { authCapabilities: AuthCapabilities }) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const [socialLoading, setSocialLoading] = useState<
    "google" | "microsoft" | null
  >(null);
  const signInOptions = resolveSignInOptions({
    authCapabilities,
    socialProviderFlags: {
      google: env.VITE_AUTH_GOOGLE,
      microsoft: env.VITE_AUTH_MICROSOFT,
    },
  });
  const {
    accountCreation,
    showEmailOtp,
    showLocalPassword,
    showBootstrap,
    showReviewPasswordSignIn,
    showGoogle,
    showMicrosoft,
    showSocialProviders,
    hasAboveEmailOptions,
  } = signInOptions;
  const lastUsed = resolveLastUsedSignInMethod({
    stored: readLastUsedLoginMethod(),
    options: signInOptions,
  });

  const handleOtpSent = async (email: string) => {
    if (onOtpSent) {
      onOtpSent({ email, redirectTo });
      return;
    }

    await navigate({
      to: "/auth/otp",
      search: { email, redirectTo },
    });
  };

  const handleSocialSignIn = async (provider: "google" | "microsoft") => {
    setSocialLoading(provider);
    const callbackURL = new URL("/auth/organization", window.location.origin);
    const errorCallbackURL = new URL("/auth/error", window.location.origin);
    if (redirectTo) {
      callbackURL.searchParams.set("redirectTo", redirectTo);
      errorCallbackURL.searchParams.set("redirectTo", redirectTo);
    }
    const { error } = await authClient.signIn.social({
      provider,
      callbackURL: callbackURL.toString(),
      errorCallbackURL: errorCallbackURL.toString(),
      // The OAuth state carries the statement version this page showed to
      // the callback that creates a new account.
      additionalData: {
        [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]:
          PROFESSIONAL_USE_STATEMENT_VERSION,
      },
    });

    if (!error) {
      return;
    }

    analytics.captureError(toAuthClientError(error));
    if (error.status !== HTTP_TOO_MANY_REQUESTS) {
      notifyUserError(toAuthClientError(error), t("errors.actionFailed"));
    }
    setSocialLoading(null);
  };

  const form = useForm(
    schemaFormOptions({
      schema: formSchema,
      defaultValues: { email: "" },
      submitValues: "schema-output",
      onSubmit: async ({ value }) => {
        const { error } = await authClient.emailOtp.sendVerificationOtp({
          email: value.email,
          type: "sign-in",
        });

        if (error) {
          analytics.captureError(toAuthClientError(error));
          if (error.status !== HTTP_TOO_MANY_REQUESTS) {
            notifyUserError(toAuthClientError(error), t("errors.actionFailed"));
          }
          return;
        }

        await handleOtpSent(value.email);
      },
    }),
  );

  const { formErrors, dirty } = useSelector(form.store, (s) => ({
    formErrors: toFormErrors(s.fieldMeta),
    dirty: !s.isDefaultValue,
  }));

  return (
    <div className={cn("flex w-full max-w-md flex-col gap-8", className)}>
      {showHeading && (
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
      )}

      {showSocialProviders && (
        <div className="flex flex-col gap-3">
          {showGoogle && (
            <SocialButton
              disabled={socialLoading !== null}
              icon={<GoogleIcon />}
              label={t("auth.continueWithGoogle")}
              lastUsed={lastUsed}
              method={SIGN_IN_METHOD.google}
              loading={socialLoading === "google"}
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
          {showMicrosoft && (
            <SocialButton
              disabled={socialLoading !== null}
              icon={<MicrosoftIcon />}
              label={t("auth.continueWithMicrosoft")}
              lastUsed={lastUsed}
              method={SIGN_IN_METHOD.microsoft}
              loading={socialLoading === "microsoft"}
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

      {showBootstrap && (
        <BootstrapSignUpForm
          hasSocialProviders={showSocialProviders}
          redirectTo={redirectTo}
        />
      )}

      {showLocalPassword && !showBootstrap && (
        <PasswordSignInForm
          autoFocus={!showSocialProviders}
          lastUsed={lastUsed}
          redirectTo={redirectTo}
        />
      )}

      {showEmailOtp && hasAboveEmailOptions && (
        <TextSeparator>{t("auth.orSignInWithEmail")}</TextSeparator>
      )}

      {showEmailOtp && (
        <Form
          dirty={dirty}
          onDiscard={() => form.reset()}
          errors={formErrors}
          onSubmit={(e) => {
            e.preventDefault();
            detached(form.handleSubmit(), "sign-in-panel.submit");
          }}
        >
          <form.Field name="email">
            {(field) => (
              <Field name={field.name}>
                <Input
                  autoFocus={!showSocialProviders && !showLocalPassword}
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
              <LastUsedSignInFrame
                lastUsed={lastUsed === SIGN_IN_METHOD.emailOtp}
              >
                {(describedBy) => (
                  <Button
                    aria-describedby={describedBy}
                    className="w-full"
                    disabled={!canSubmit || email.trim().length === 0}
                    loading={isSubmitting}
                    type="submit"
                    variant={signInMethodVariant({
                      method: SIGN_IN_METHOD.emailOtp,
                      lastUsed,
                      fallback: "default",
                    })}
                  >
                    {t("auth.continueWithEmail")}
                  </Button>
                )}
              </LastUsedSignInFrame>
            )}
          </form.Subscribe>
        </Form>
      )}
      {showReviewPasswordSignIn && (
        <PasswordSignInOption redirectTo={redirectTo} />
      )}
      <p className="text-foreground-muted text-xs">
        {t.rich("onboarding.termsNotice", {
          terms: renderTermsLink,
        })}
      </p>
      {accountCreation === "offered" && (
        <p className="text-foreground-muted text-xs">
          {t("auth.professionalUseStatement")}
        </p>
      )}
    </div>
  );
};

const BootstrapSignUpForm = ({
  hasSocialProviders,
  redirectTo,
}: {
  hasSocialProviders: boolean;
  redirectTo: string;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const invalidateSession = useInvalidateSession();
  const form = useForm(
    schemaFormOptions({
      schema: bootstrapFormSchema,
      defaultValues: { email: "", password: "", bootstrapToken: "" },
      submitValues: "schema-output",
      onSubmit: async ({ value }) => {
        const { email, password, bootstrapToken } = value;
        const { error } = await signUpWithSelfhostBootstrap({
          email,
          password,
          name: getFallbackName(email),
          bootstrapToken,
          callbackURL: getOrganizationCallbackUrl(redirectTo),
          [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]:
            PROFESSIONAL_USE_STATEMENT_VERSION,
        });

        if (error) {
          analytics.captureError(toAuthClientError(error));
          if (error.status !== HTTP_TOO_MANY_REQUESTS) {
            notifyUserError(toAuthClientError(error), t("errors.actionFailed"));
          }
          return;
        }

        await invalidateSession.mutateAsync();
        await navigate({
          to: "/auth/organization",
          search: { redirectTo },
        });
      },
    }),
  );
  const { formErrors, dirty } = useSelector(form.store, (s) => ({
    formErrors: toFormErrors(s.fieldMeta),
    dirty: !s.isDefaultValue,
  }));

  return (
    <div className="flex flex-col gap-3">
      <TextSeparator>{t("auth.createFirstAccount")}</TextSeparator>
      <Form
        dirty={dirty}
        onDiscard={() => form.reset()}
        errors={formErrors}
        onSubmit={(e) => {
          e.preventDefault();
          detached(form.handleSubmit(), "sign-in-panel.submit");
        }}
      >
        <form.Field name="email">
          {(field) => (
            <EmailCredentialField
              autoFocus={!hasSocialProviders}
              field={field}
            />
          )}
        </form.Field>
        <form.Field name="password">
          {(field) => (
            <SecretCredentialField
              autoComplete="new-password"
              field={field}
              placeholder={t("auth.password")}
            />
          )}
        </form.Field>
        <form.Field name="bootstrapToken">
          {(field) => (
            <SecretCredentialField
              autoComplete="one-time-code"
              field={field}
              placeholder={t("auth.bootstrapToken")}
            />
          )}
        </form.Field>
        <form.Subscribe
          selector={(s) => ({
            isSubmitting: s.isSubmitting,
            canSubmit: s.canSubmit,
            email: s.values.email,
            password: s.values.password,
            bootstrapToken: s.values.bootstrapToken,
          })}
        >
          {({ isSubmitting, canSubmit, email, password, bootstrapToken }) => (
            <Button
              className="w-full"
              disabled={
                !canSubmit ||
                email.trim().length === 0 ||
                password.trim().length === 0 ||
                bootstrapToken.trim().length === 0
              }
              loading={isSubmitting}
              type="submit"
            >
              {t("auth.createFirstAccount")}
            </Button>
          )}
        </form.Subscribe>
      </Form>
    </div>
  );
};

const getFallbackName = (email: string) => {
  const localPart = email.split("@").at(0)?.trim();
  return localPart && localPart.length > 0 ? localPart : email;
};

type SelfhostBootstrapSignUpInput = {
  email: string;
  password: string;
  name: string;
  bootstrapToken: string;
  callbackURL: string;
  [PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD]: string;
};

const signUpWithSelfhostBootstrap = async (
  body: SelfhostBootstrapSignUpInput,
) => {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${browserAuthBaseUrl()}${BETTER_AUTH_SIGN_UP_EMAIL_PATH}`,
      {
        method: "POST",
        credentials: "include",
        timeoutMs: 10_000,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  } catch {
    return {
      error: {
        status: 0,
        statusText: "Network Error",
        message: undefined,
      },
    };
  }

  if (response.ok) {
    return { error: null };
  }

  const payload: unknown = await response.json().catch(() => null);
  const parsedPayload = v.safeParse(authErrorResponseSchema, payload);
  return {
    error: {
      status: response.status,
      statusText: response.statusText,
      message: parsedPayload.success ? parsedPayload.output.message : undefined,
    },
  };
};

const SocialButton = ({
  icon,
  label,
  lastUsed,
  method,
  loading,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  lastUsed: SignInMethod | null;
  method: SignInMethod;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) => (
  <LastUsedSignInFrame lastUsed={lastUsed === method}>
    {(describedBy) => (
      <Button
        aria-describedby={describedBy}
        className="w-full min-w-0 shrink max-sm:h-auto max-sm:min-h-10 max-sm:px-2 max-sm:py-2 max-sm:text-[0.95rem] max-sm:leading-tight max-sm:whitespace-normal sm:whitespace-nowrap"
        disabled={disabled}
        loading={loading}
        onClick={onClick}
        size="lg"
        variant={signInMethodVariant({ method, lastUsed, fallback: "outline" })}
      >
        {icon}
        <span className="min-w-0 text-center">{label}</span>
      </Button>
    )}
  </LastUsedSignInFrame>
);

const GoogleIcon = () => (
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

const MicrosoftIcon = () => (
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

export const SignInPanel = (props: SignInPanelProps) => {
  const capabilitiesQuery = useQuery(authCapabilitiesOptions);
  const capabilitiesView = useQueryView(capabilitiesQuery);
  if (capabilitiesView.type !== "items") {
    return <QueryViewFeedback view={capabilitiesView} />;
  }
  return (
    <>
      <QueryViewFeedback view={capabilitiesView} />
      <SignInOptionsPanel
        {...props}
        authCapabilities={capabilitiesView.items}
      />
    </>
  );
};
