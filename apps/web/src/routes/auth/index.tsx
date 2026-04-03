import { useForm, useStore } from "@tanstack/react-form";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stella/ui/components/button";
import { Field, FieldError } from "@stella/ui/components/field";
import { Form } from "@stella/ui/components/form";
import { Input } from "@stella/ui/components/input";
import { toastManager } from "@stella/ui/components/toast";

import { useAnalytics } from "@/lib/analytics/provider";
import { authClient, HTTP_TOO_MANY_REQUESTS } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { pageTitle } from "@/lib/page-title";
import { isAcceptInvitationRedirect, redirectToSchema } from "@/lib/redirect";
import { emailSchema, toFormErrors } from "@/lib/schema";

const searchSchema = v.strictObject({
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/")({
  head: () => ({
    meta: [{ title: pageTitle("auth.signIn") }],
  }),
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
  component: LoginOrSignup,
});

const formSchema = v.strictObject({
  email: emailSchema(),
});

function LoginOrSignup() {
  const t = useTranslations();
  const analytics = useAnalytics();
  const navigate = Route.useNavigate();
  const redirectTo = Route.useSearch({ select: (s) => s.redirectTo });

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
          toastManager.add({
            title: error.message ?? t("errors.actionFailed"),
            type: "error",
          });
        }
        return;
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
          {t("auth.signInWithEmail")}
        </h2>
        {isAcceptInvitationRedirect(redirectTo) && (
          <p className="text-muted-foreground text-sm">
            {t("auth.signInBeforeInvitation")}
          </p>
        )}
      </div>
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
                autoFocus
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
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <Button className="w-full" loading={isSubmitting} type="submit">
              {t("auth.continueWithEmail")}
            </Button>
          )}
        </form.Subscribe>
      </Form>
      <p className="text-muted-foreground/60 text-xs">
        {t.rich("onboarding.termsNotice", {
          terms: (chunks: React.ReactNode) => (
            <a
              className="hover:text-foreground underline"
              href="/terms"
              rel="noopener"
              target="_blank"
            >
              {chunks}
            </a>
          ),
          privacy: (chunks: React.ReactNode) => (
            <a
              className="hover:text-foreground underline"
              href="/privacy"
              rel="noopener"
              target="_blank"
            >
              {chunks}
            </a>
          ),
        })}
      </p>
    </div>
  );
}
