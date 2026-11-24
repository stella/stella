import { useId, useState } from "react";
import type { ReactNode } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  PROFESSIONAL_USE_DISPLAYED_VERSION_FIELD,
  PROFESSIONAL_USE_STATEMENT_VERSION,
} from "@stll/api-contract/professional-use";
import { AUTH_SIGN_IN_CODE_UNAVAILABLE_ERROR_CODE } from "@stll/auth-model";
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
import { queryView } from "@/lib/query-view.logic";
import { isAcceptInvitationRedirect } from "@/lib/redirect";
import { emailSchema, schemaFormOptions, toFormErrors } from "@/lib/schema";

import type { SocialProvider } from "./access-reset.logic";
import { newSignInAttempt, signInAttemptHeaders } from "./email-delivery.logic";
import {
  LAST_USED_BADGE_PILL_CLASS_NAME,
  LAST_USED_BADGE_POSITION_CLASS_NAME,
  LastUsedFieldBadge,
  readLastUsedLoginMethod,
} from "./last-used-sign-in";
import {
  EmailCredentialField,
  getOrganizationCallbackUrl,
  PasswordSignInForm,
  SecretCredentialField,
} from "./password-sign-in-form";
import { PasswordSignInOption } from "./password-sign-in-option";
import { GoogleIcon, MicrosoftIcon } from "./sign-in-brand-marks";
import { socialProviderFlags } from "./sign-in-deployment.logic";
import { SIGN_IN_MODE } from "./sign-in-mode";
import type { SignInMode } from "./sign-in-mode";
import {
  SIGN_IN_CREDENTIAL_INPUT_SIZE,
  SignInEmailDivider,
  SignInHeading,
  SignInMethodSwitch,
  SignInPanelPending,
  SignInPanelShell,
} from "./sign-in-panel-face.pending";
import {
  initialPasswordEntry,
  resolveLastUsedSignInMethod,
  resolveSignInOptions,
  SIGN_IN_METHOD,
  signInMethodVariant,
} from "./sign-in-panel.logic";
import type {
  AuthCapabilities,
  SignInEntryMethod,
  SignInMethod,
} from "./sign-in-panel.logic";

type SignInPanelProps = {
  mode?: SignInMode;
  className?: string;
  /** The method a link asked this page to open with. */
  entryMethod?: SignInEntryMethod | undefined;
  redirectTo: string;
  reserveInvitationHint?: boolean;
  showHeading?: boolean;
  onOtpSent?: (payload: {
    email: string;
    redirectTo: string;
    mode: SignInMode;
    /** The attempt id the code request carried, to follow its mail. */
    signInAttempt: string;
  }) => void;
};

const formSchema = (invalidEmail: string) =>
  v.strictObject({
    email: emailSchema(invalidEmail),
  });

const bootstrapFormSchema = (invalidEmail: string) =>
  v.strictObject({
    email: emailSchema(invalidEmail),
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
  entryMethod,
  redirectTo,
  heading,
  feedback,
  mode = SIGN_IN_MODE.signIn,
  onOtpSent,
  authCapabilities,
}: SignInPanelProps & {
  authCapabilities: AuthCapabilities;
  heading: ReactNode;
  feedback: ReactNode;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const [socialLoading, setSocialLoading] = useState<SocialProvider | null>(
    null,
  );
  const signInOptions = resolveSignInOptions({
    authCapabilities,
    socialProviderFlags,
  });
  const {
    accountCreation,
    showEmailOtp,
    showLocalPassword,
    showBootstrap,
    showReviewPasswordSignIn,
    showGoogle,
    showMicrosoft,
    showApple,
    showSocialProviders,
  } = signInOptions;
  const lastUsed = resolveLastUsedSignInMethod({
    stored: readLastUsedLoginMethod(),
    options: signInOptions,
  });
  const [passwordEntry, setPasswordEntry] = useState(() =>
    initialPasswordEntry({ entryMethod, options: signInOptions }),
  );
  const hasCredentialOption =
    showBootstrap ||
    showLocalPassword ||
    showEmailOtp ||
    passwordEntry.type === "open";
  const openPasswordEntry = (email: string) =>
    setPasswordEntry({ type: "open", email });

  const handleOtpSent = async (email: string, signInAttempt: string) => {
    if (onOtpSent) {
      onOtpSent({ email, redirectTo, mode, signInAttempt });
      return;
    }

    await navigate({
      to: "/auth/otp",
      search: { email, redirectTo, mode, signInAttempt },
    });
  };

  const handleSocialSignIn = async (provider: SocialProvider) => {
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

    analytics.captureError(toAuthClientError(error), {
      fingerprintKey: "SignInOptionsPanel.handleSocialSignIn:failure",
      scope: {
        type: "handler",
        handlerId: "SignInOptionsPanel.handleSocialSignIn:failure",
      },
    });
    if (error.status !== HTTP_TOO_MANY_REQUESTS) {
      notifyUserError(toAuthClientError(error), t("errors.actionFailed"));
    }
    setSocialLoading(null);
  };

  return (
    <SignInPanelShell
      className={className}
      heading={heading}
      feedback={feedback}
      social={{
        google: showGoogle && (
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
                  {
                    fingerprintKey: "SignInOptionsPanel:failure",
                    scope: {
                      type: "handler",
                      handlerId: "SignInOptionsPanel:failure",
                    },
                  },
                );
              });
            }}
          />
        ),
        microsoft: showMicrosoft && (
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
                  {
                    fingerprintKey: "SignInOptionsPanel:failure-2",
                    scope: {
                      type: "handler",
                      handlerId: "SignInOptionsPanel:failure-2",
                    },
                  },
                );
              });
            }}
          />
        ),
        apple: showApple && (
          <SocialButton
            disabled={socialLoading !== null}
            icon={<AppleIcon />}
            label={t("auth.continueWithApple")}
            lastUsed={lastUsed}
            method={SIGN_IN_METHOD.apple}
            loading={socialLoading === "apple"}
            onClick={() => {
              handleSocialSignIn("apple").catch((error: unknown) => {
                setSocialLoading(null);
                analytics.captureError(
                  error instanceof Error ? error : new Error(String(error)),
                  {
                    fingerprintKey: "SignInOptionsPanel:failure-3",
                    scope: {
                      type: "handler",
                      handlerId: "SignInOptionsPanel:failure-3",
                    },
                  },
                );
              });
            }}
          />
        ),
      }}
      beforeCredentials={
        hasCredentialOption && (
          <SignInEmailDivider>
            {showBootstrap
              ? t("auth.createFirstAccount")
              : !showLocalPassword &&
                showEmailOtp &&
                showSocialProviders &&
                t("auth.orSignInWithEmail")}
          </SignInEmailDivider>
        )
      }
      bootstrap={
        showBootstrap && (
          <BootstrapSignUpForm
            hasSocialProviders={showSocialProviders}
            redirectTo={redirectTo}
          />
        )
      }
      credentials={
        showLocalPassword &&
        !showBootstrap && (
          <PasswordSignInForm
            autoFocus={!showSocialProviders}
            defaultEmail=""
            lastUsed={lastUsed}
            redirectTo={redirectTo}
          />
        )
      }
      separator={
        showLocalPassword &&
        showEmailOtp && (
          <TextSeparator>{t("auth.orSignInWithEmail")}</TextSeparator>
        )
      }
      alternate={
        passwordEntry.type === "open" ? (
          <PasswordSignInOption
            email={passwordEntry.email}
            onUseEmailCode={
              showEmailOtp
                ? () => setPasswordEntry({ type: "closed" })
                : undefined
            }
            redirectTo={redirectTo}
          />
        ) : (
          showEmailOtp && (
            <EmailCodeSignInForm
              autoFocus={!showSocialProviders && !showLocalPassword}
              lastUsed={lastUsed}
              onCodeSent={handleOtpSent}
              onPasswordRequired={openPasswordEntry}
              onUsePassword={
                showReviewPasswordSignIn ? openPasswordEntry : undefined
              }
            />
          )
        )
      }
      terms={t.rich("onboarding.termsNotice", { terms: renderTermsLink })}
      professionalUse={
        accountCreation === "offered"
          ? t("auth.professionalUseStatement")
          : undefined
      }
    />
  );
};

/** The email step of code sign-in: asks the server to send the code. */
const EmailCodeSignInForm = ({
  autoFocus,
  lastUsed,
  onCodeSent,
  onPasswordRequired,
  onUsePassword,
}: {
  autoFocus: boolean;
  lastUsed: SignInMethod | null;
  /** The code was requested under `signInAttempt`. */
  onCodeSent: (email: string, signInAttempt: string) => Promise<void>;
  /** The server sends this address no code: it signs in with a password. */
  onPasswordRequired: (email: string) => void;
  /** Opens the password form with the address typed so far, where offered. */
  onUsePassword: ((email: string) => void) | undefined;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const form = useForm(
    schemaFormOptions({
      schema: formSchema(t("validation.invalidEmail")),
      defaultValues: { email: "" },
      submitValues: "schema-output",
      onSubmit: async ({ value }) => {
        const signInAttempt = newSignInAttempt();
        const { error } = await authClient.emailOtp.sendVerificationOtp({
          email: value.email,
          type: "sign-in",
          fetchOptions: { headers: signInAttemptHeaders(signInAttempt) },
        });

        if (error?.code === AUTH_SIGN_IN_CODE_UNAVAILABLE_ERROR_CODE) {
          onPasswordRequired(value.email);
          return;
        }
        if (error) {
          analytics.captureError(toAuthClientError(error), {
            fingerprintKey: "EmailCodeSignInForm.onSubmit:failure",
            scope: {
              type: "handler",
              handlerId: "EmailCodeSignInForm.onSubmit:failure",
            },
          });
          if (error.status !== HTTP_TOO_MANY_REQUESTS) {
            notifyUserError(toAuthClientError(error), t("errors.actionFailed"));
          }
          return;
        }

        await onCodeSent(value.email, signInAttempt);
      },
    }),
  );

  const { formErrors, dirty } = useSelector(form.store, (s) => ({
    formErrors: toFormErrors(s.fieldMeta),
    dirty: !s.isDefaultValue,
  }));

  return (
    <>
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
            <Field className="relative" name={field.name}>
              <Input
                autoFocus={autoFocus}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                placeholder={t("auth.emailPlaceholder")}
                size={SIGN_IN_CREDENTIAL_INPUT_SIZE}
                type="email"
                value={field.state.value}
              />
              {lastUsed === SIGN_IN_METHOD.emailOtp && <LastUsedFieldBadge />}
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
              disabledReason={
                isSubmitting
                  ? t("auth.sendingCode")
                  : t("validation.invalidEmail")
              }
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
        </form.Subscribe>
      </Form>
      {onUsePassword && (
        <SignInMethodSwitch>
          <Button
            onClick={() => onUsePassword(form.state.values.email)}
            size="sm"
            type="button"
            variant="link"
          >
            {t("auth.usePassword")}
          </Button>
        </SignInMethodSwitch>
      )}
    </>
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
      schema: bootstrapFormSchema(t("validation.invalidEmail")),
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
          analytics.captureError(toAuthClientError(error), {
            fingerprintKey: "BootstrapSignUpForm.onSubmit:failure",
            scope: {
              type: "handler",
              handlerId: "BootstrapSignUpForm.onSubmit:failure",
            },
          });
          if (error.status !== HTTP_TOO_MANY_REQUESTS) {
            notifyUserError(toAuthClientError(error), t("errors.actionFailed"));
          }
          return;
        }

        const refreshed = await Result.tryPromise(
          async () => await invalidateSession.mutateAsync(),
        );
        if (refreshed.isErr()) {
          notifyUserError(refreshed.error, t("errors.actionFailed"));
          return;
        }
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
            lastUsed={false}
          />
        )}
      </form.Field>
      <form.Field name="password">
        {(field) => (
          <SecretCredentialField
            autoComplete="new-password"
            autoFocus={false}
            field={field}
            placeholder={t("auth.password")}
          />
        )}
      </form.Field>
      <form.Field name="bootstrapToken">
        {(field) => (
          <SecretCredentialField
            autoComplete="one-time-code"
            autoFocus={false}
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
            disabledReason={
              isSubmitting
                ? t("auth.confirmingHandoff")
                : t("auth.enterBootstrapCredentials")
            }
            loading={isSubmitting}
            type="submit"
          >
            {t("auth.createFirstAccount")}
          </Button>
        )}
      </form.Subscribe>
    </Form>
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

/**
 * Wraps a one-click sign-in action (a social provider button) and, when it
 * is the last-used method, pins a "Last used" badge to its corner and links
 * it as the action's description. Methods typed into a form mark their email
 * field with `LastUsedFieldBadge` instead; a submit button never carries it.
 */
const LastUsedSignInFrame = ({
  lastUsed,
  children,
}: {
  lastUsed: boolean;
  children: (describedBy: string | undefined) => ReactNode;
}) => {
  const t = useTranslations();
  const badgeId = useId();
  return (
    <div className="relative">
      {children(lastUsed ? badgeId : undefined)}
      {lastUsed && (
        <span
          className={cn(
            LAST_USED_BADGE_POSITION_CLASS_NAME,
            LAST_USED_BADGE_PILL_CLASS_NAME,
          )}
          id={badgeId}
        >
          {t("auth.lastUsed")}
        </span>
      )}
    </div>
  );
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
}) => {
  const t = useTranslations();
  return (
    <LastUsedSignInFrame lastUsed={lastUsed === method}>
      {(describedBy) => (
        <Button
          aria-describedby={describedBy}
          layout="wrap"
          className="w-full min-w-0 shrink items-center justify-center text-center max-sm:px-2 max-sm:text-[0.95rem] max-sm:leading-tight"
          disabled={disabled}
          disabledReason={t("auth.confirmingHandoff")}
          loading={loading}
          onClick={onClick}
          size="lg"
          variant={signInMethodVariant({
            method,
            lastUsed,
            fallback: "outline",
          })}
        >
          {icon}
          <span className="min-w-0 text-center">{label}</span>
        </Button>
      )}
    </LastUsedSignInFrame>
  );
};

// Apple's logo in the button's own text colour, as Apple's sign-in button
// guidelines require for a custom button.
const AppleIcon = () => (
  <svg
    aria-hidden="true"
    className="size-4"
    fill="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
  </svg>
);

export const SignInPanel = (props: SignInPanelProps) => {
  const t = useTranslations();
  const capabilitiesQuery = useQuery(authCapabilitiesOptions);
  const capabilitiesView = queryView(capabilitiesQuery);
  if (capabilitiesView.type === "pending") {
    return (
      <>
        <span className="sr-only" role="status">
          {t("common.loading")}
        </span>
        <SignInPanelPending
          className={props.className}
          entryMethod={props.entryMethod}
          redirectTo={props.redirectTo}
          reserveInvitationHint={props.reserveInvitationHint}
          showHeading={props.showHeading ?? true}
        />
      </>
    );
  }
  if (capabilitiesView.type !== "items") {
    return <QueryViewFeedback view={capabilitiesView} />;
  }
  const showInvitationHint = isAcceptInvitationRedirect(props.redirectTo);
  const invitationState = showInvitationHint
    ? "visible-reserved"
    : "hidden-reserved";
  const reserveInvitationHint = props.reserveInvitationHint ?? false;
  const heading = (props.showHeading ?? true) && (
    <SignInHeading
      title={t("auth.signIn")}
      invitationState={reserveInvitationHint ? invitationState : "visible"}
      invitation={
        showInvitationHint || reserveInvitationHint
          ? t("auth.signInBeforeInvitation")
          : undefined
      }
    />
  );
  return (
    <SignInOptionsPanel
      {...props}
      authCapabilities={capabilitiesView.items}
      heading={heading}
      feedback={<QueryViewFeedback view={capabilitiesView} />}
    />
  );
};
