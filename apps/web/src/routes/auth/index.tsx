import { usePostHog } from "@posthog/react";
import { useForm, useStore } from "@tanstack/react-form";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stella/ui/components/button";
import { Field, FieldError } from "@stella/ui/components/field";
import { Form } from "@stella/ui/components/form";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stella/ui/components/frame";
import { Input } from "@stella/ui/components/input";
import { toastManager } from "@stella/ui/components/toast";

import { authClient, HTTP_TOO_MANY_REQUESTS } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import { isAcceptInvitationRedirect, redirectToSchema } from "@/lib/redirect";
import { toFormErrors } from "@/lib/schema";

const searchSchema = v.object({
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
  component: LoginOrSignup,
});

const formSchema = v.object({
  email: v.pipe(v.string(), v.email()),
});

function LoginOrSignup() {
  const t = useTranslations();
  const posthog = usePostHog();
  const navigate = Route.useNavigate();
  const { redirectTo } = Route.useSearch();

  const form = useForm({
    defaultValues: { email: "" },
    validators: {
      onDynamic: formSchema,
    },
    onSubmit: async ({ value }) => {
      const { error } = await authClient.emailOtp.sendVerificationOtp({
        email: value.email,
        type: "sign-in",
      });

      if (error) {
        captureError(posthog, toAuthClientError(error));
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
        search: { email: value.email, redirectTo },
      });
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

  return (
    <div className="flex flex-1 items-center justify-center">
      <Frame className="w-full max-w-sm">
        <FrameHeader>
          <FrameTitle>{t("auth.signInToStella")}</FrameTitle>
          {isAcceptInvitationRedirect(redirectTo) && (
            <FrameDescription>
              {t("auth.signInBeforeInvitation")}
            </FrameDescription>
          )}
        </FrameHeader>
        <FramePanel>
          <Form
            errors={formErrors}
            onSubmit={(e) => {
              e.preventDefault();
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
                    type="email"
                    value={field.state.value}
                  />
                  <FieldError />
                </Field>
              )}
            </form.Field>
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button
                  className="w-full"
                  disabled={isSubmitting}
                  type="submit"
                >
                  {t("auth.signIn")}
                </Button>
              )}
            </form.Subscribe>
          </Form>
        </FramePanel>
      </Frame>
    </div>
  );
}
