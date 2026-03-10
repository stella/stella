import { usePostHog } from "@posthog/react";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Avatar, AvatarFallback } from "@stella/ui/components/avatar";
import { Button } from "@stella/ui/components/button";
import { Field, FieldError, FieldLabel } from "@stella/ui/components/field";
import { Form } from "@stella/ui/components/form";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stella/ui/components/frame";
import { Input } from "@stella/ui/components/input";
import { Skeleton } from "@stella/ui/components/skeleton";
import { toastManager } from "@stella/ui/components/toast";

import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";
import { isAcceptInvitationRedirect, redirectToSchema } from "@/lib/redirect";
import { toFormErrors } from "@/lib/schema";
import {
  createSlug,
  getOrganizationSchema,
} from "@/routes/_protected.organization/-utils";

const searchSchema = v.object({
  redirectTo: redirectToSchema,
});

export const Route = createFileRoute("/auth/organization")({
  validateSearch: searchSchema,
  beforeLoad: ({ context, search }) => {
    if (!context.session) {
      throw redirect({ to: "/auth", replace: true });
    }

    if (
      context.session?.activeOrganizationId ||
      isAcceptInvitationRedirect(search.redirectTo)
    ) {
      throw redirect({ to: search.redirectTo, replace: true });
    }
  },
  component: Organization,
});

function Organization() {
  const { data: organizations, isPending } = authClient.useListOrganizations();
  const hasOrgs = organizations && organizations.length > 0;

  if (isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Frame className="w-full max-w-sm">
          <FrameHeader>
            <Skeleton className="h-5 w-48" />
            <Skeleton className="mt-2 h-4 w-64" />
          </FrameHeader>
          <FramePanel className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </FramePanel>
        </Frame>
      </div>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center">
      {hasOrgs ? (
        <OrganizationList organizations={organizations} />
      ) : (
        <CreateOrganizationForm />
      )}
    </div>
  );
}

type OrganizationListProps = {
  organizations: { id: string; name: string; slug: string }[];
};

const OrganizationList = ({ organizations }: OrganizationListProps) => {
  const t = useTranslations();
  const { redirectTo } = Route.useSearch();
  const posthog = usePostHog();
  const navigate = Route.useNavigate();
  const invalidateSession = useInvalidateSession();

  const selectOrganization = useMutation({
    mutationFn: async (organizationId: string) => {
      const { error } = await authClient.organization.setActive({
        organizationId,
      });

      if (error) {
        toastManager.add({
          title: error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(error);
      }

      await invalidateSession.mutateAsync();
      await navigate({ to: redirectTo, replace: true });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{t("auth.selectOrganization")}</FrameTitle>
        <FrameDescription>{t("auth.chooseOrganization")}</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-2">
        {organizations.map((org) => (
          <button
            className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-start transition-colors hover:bg-accent/50 disabled:opacity-64"
            disabled={selectOrganization.isPending}
            key={org.id}
            onClick={() => selectOrganization.mutate(org.id)}
            type="button"
          >
            <Avatar className="size-10">
              <AvatarFallback>
                {org.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium">{org.name}</p>
              <p className="text-sm text-muted-foreground">{org.slug}</p>
            </div>
          </button>
        ))}
      </FramePanel>
    </Frame>
  );
};

const CreateOrganizationForm = () => {
  const t = useTranslations();
  const { redirectTo } = Route.useSearch();
  const posthog = usePostHog();
  const navigate = Route.useNavigate();
  const invalidateSession = useInvalidateSession();

  const form = useForm({
    defaultValues: { name: "", slug: "" },
    validators: {
      onDynamic: getOrganizationSchema(),
    },
    onSubmit: async ({ value, formApi }) => {
      const { data: slugCheckData, error: slugCheckError } =
        await authClient.organization.checkSlug({
          slug: value.slug,
        });

      if (slugCheckError) {
        captureError(posthog, toAuthClientError(slugCheckError));
        toastManager.add({
          title: slugCheckError.message ?? t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      if (slugCheckData?.status !== true) {
        formApi.setErrorMap({
          onSubmit: { fields: { slug: t("errors.slugAlreadyTaken") } },
        });
        return;
      }

      const { data, error: createError } = await authClient.organization.create(
        {
          name: value.name,
          slug: value.slug,
        },
      );

      if (createError) {
        captureError(posthog, toAuthClientError(createError));
        toastManager.add({
          title: createError.message ?? t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      const { error: setActiveError } = await authClient.organization.setActive(
        {
          organizationId: data.id,
        },
      );

      if (setActiveError) {
        captureError(posthog, toAuthClientError(setActiveError));
        toastManager.add({
          title: setActiveError.message ?? t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      await invalidateSession.mutateAsync();
      await navigate({ to: redirectTo, replace: true });
    },
  });

  const formErrors = useStore(form.store, (s) => toFormErrors(s.fieldMeta));

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{t("auth.createOrganization")}</FrameTitle>
        <FrameDescription>{t("auth.createFirstOrganization")}</FrameDescription>
      </FrameHeader>
      <FramePanel>
        <Form
          errors={formErrors}
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel>{t("auth.organizationNameLabel")}</FieldLabel>
                <Input
                  autoFocus
                  onBlur={field.handleBlur}
                  onChange={(e) => {
                    const value = e.target.value;
                    field.handleChange(value);
                    form.setFieldValue("slug", createSlug(value));
                  }}
                  placeholder={t("auth.organizationNamePlaceholder")}
                  required
                  value={field.state.value}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Field name="slug">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel>{t("auth.slugLabel")}</FieldLabel>
                <Input
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  placeholder={t("auth.slugPlaceholder")}
                  required
                  value={field.state.value}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Button className="w-full" loading={isSubmitting} type="submit">
                {t("auth.createOrganizationButton")}
              </Button>
            )}
          </form.Subscribe>
        </Form>
      </FramePanel>
    </Frame>
  );
};
