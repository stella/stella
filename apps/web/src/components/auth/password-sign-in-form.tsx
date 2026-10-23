import { useForm, useSelector } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import { Field, FieldError } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";

import { SecretInput } from "@/components/secret-input";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import {
  authClient,
  HTTP_TOO_MANY_REQUESTS,
  isTwoFactorRedirect,
} from "@/lib/auth-client";
import { detached } from "@/lib/detached";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";
import { emailSchema, schemaFormOptions, toFormErrors } from "@/lib/schema";

import { LastUsedFieldBadge } from "./last-used-sign-in";
import { SIGN_IN_METHOD, signInMethodVariant } from "./sign-in-panel.logic";
import type { SignInMethod } from "./sign-in-panel.logic";

const passwordFormSchema = v.strictObject({
  email: emailSchema(),
  password: v.string(),
});

/** The slice of a form field a single text input binds to. */
type TextFieldBinding = {
  handleBlur: () => void;
  handleChange: (value: string) => void;
  name: string;
  state: { value: string };
};

export const EmailCredentialField = ({
  autoFocus,
  field,
  lastUsed,
}: {
  autoFocus: boolean;
  field: TextFieldBinding;
  /** This form's method is the one this browser signed in with last. */
  lastUsed: boolean;
}) => {
  const t = useTranslations();
  return (
    <Field className="relative" name={field.name}>
      <Input
        autoComplete="email"
        autoFocus={autoFocus}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        placeholder={t("auth.emailPlaceholder")}
        size="lg"
        type="email"
        value={field.state.value}
      />
      {lastUsed && <LastUsedFieldBadge />}
      <FieldError />
    </Field>
  );
};

export const SecretCredentialField = ({
  autoComplete,
  field,
  placeholder,
}: {
  autoComplete: "current-password" | "new-password" | "one-time-code";
  field: TextFieldBinding;
  placeholder: string;
}) => (
  <Field name={field.name}>
    <SecretInput
      autoComplete={autoComplete}
      onBlur={field.handleBlur}
      onChange={(e) => field.handleChange(e.target.value)}
      placeholder={placeholder}
      size="lg"
      value={field.state.value}
    />
    <FieldError />
  </Field>
);

export const getOrganizationCallbackUrl = (redirectTo: string) => {
  const callbackURL = new URL("/auth/organization", window.location.origin);
  if (redirectTo) {
    callbackURL.searchParams.set("redirectTo", redirectTo);
  }
  return callbackURL.toString();
};

export const PasswordSignInForm = ({
  autoFocus,
  lastUsed,
  redirectTo,
}: {
  autoFocus: boolean;
  lastUsed: SignInMethod | null;
  redirectTo: string;
}) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const invalidateSession = useInvalidateSession();
  const form = useForm(
    schemaFormOptions({
      schema: passwordFormSchema,
      defaultValues: { email: "", password: "" },
      submitValues: "schema-output",
      onSubmit: async ({ value }) => {
        const { data, error } = await authClient.signIn.email({
          email: value.email,
          password: value.password,
          callbackURL: getOrganizationCallbackUrl(redirectTo),
        });

        if (error) {
          analytics.captureError(toAuthClientError(error), {
            fingerprintKey: "PasswordSignInForm.onSubmit:failure",
            scope: {
              type: "handler",
              handlerId: "PasswordSignInForm.onSubmit:failure",
            },
          });
          if (error.status !== HTTP_TOO_MANY_REQUESTS) {
            notifyUserError(toAuthClientError(error), t("errors.actionFailed"));
          }
          return;
        }

        // An enrolled user's password is correct but the session is still
        // pending a second factor; send them to the same challenge page the
        // email-OTP flow uses instead of treating this as a completed sign-in.
        if (isTwoFactorRedirect(data)) {
          await invalidateSession.mutateAsync();
          await navigate({
            to: "/auth/two-factor",
            search: { redirectTo },
          });
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
            autoFocus={autoFocus}
            field={field}
            lastUsed={lastUsed === SIGN_IN_METHOD.password}
          />
        )}
      </form.Field>
      <form.Field name="password">
        {(field) => (
          <SecretCredentialField
            autoComplete="current-password"
            field={field}
            placeholder={t("auth.password")}
          />
        )}
      </form.Field>
      <form.Subscribe
        selector={(s) => ({
          isSubmitting: s.isSubmitting,
          canSubmit: s.canSubmit,
          email: s.values.email,
          password: s.values.password,
        })}
      >
        {({ isSubmitting, canSubmit, email, password }) => (
          <Button
            className="w-full"
            disabled={
              !canSubmit ||
              email.trim().length === 0 ||
              password.trim().length === 0
            }
            loading={isSubmitting}
            type="submit"
            variant={signInMethodVariant({
              method: SIGN_IN_METHOD.password,
              lastUsed,
              fallback: "default",
            })}
          >
            {t("auth.signInWithPassword")}
          </Button>
        )}
      </form.Subscribe>
    </Form>
  );
};
