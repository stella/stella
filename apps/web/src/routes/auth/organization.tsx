import { useEffect, useRef } from "react";

import { useForm, useStore } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
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
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { getOauthRedirectUrl, hasSignedOauthQuery } from "@/lib/oauth-provider";
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
  beforeLoad: ({ context, location, search }) => {
    if (!context.session) {
      throw redirect({
        to: "/auth",
        search: {
          redirectTo: location.pathname + location.searchStr,
        },
        replace: true,
      });
    }

    const isOauthPostLogin = hasSignedOauthQuery(location.searchStr);

    if (
      !isOauthPostLogin &&
      (context.session.activeOrganizationId ||
        isAcceptInvitationRedirect(search.redirectTo))
    ) {
      throw redirect({ to: search.redirectTo, replace: true });
    }
  },
  component: Organization,
});

function Organization() {
  const { data: organizations, isPending } = authClient.useListOrganizations();
  const hasOrganizations = (organizations?.length ?? 0) > 0;
  const isOauthPostLogin =
    typeof window !== "undefined" &&
    hasSignedOauthQuery(window.location.search);
  const navigate = useNavigate();

  useEffect(() => {
    if (!isPending && !hasOrganizations && !isOauthPostLogin) {
      // eslint-disable-next-line typescript/no-floating-promises
      navigate({ to: "/onboarding", replace: true });
    }
  }, [hasOrganizations, isOauthPostLogin, isPending, navigate]);

  if (isPending || (!hasOrganizations && !isOauthPostLogin)) {
    return (
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
    );
  }

  return (
    <div className="flex flex-1 items-center justify-center">
      {hasOrganizations ? (
        <OrganizationList
          isOauthPostLogin={isOauthPostLogin}
          organizations={organizations ?? []}
        />
      ) : (
        <CreateOrganizationForm isOauthPostLogin={isOauthPostLogin} />
      )}
    </div>
  );
}

type OrganizationListProps = {
  isOauthPostLogin: boolean;
  organizations: { id: string; name: string; slug: string }[];
};

const completeOrganizationFlow = async ({
  invalidateSession,
  isOauthPostLogin,
  navigate,
  redirectTo,
  status,
}: {
  invalidateSession: ReturnType<typeof useInvalidateSession>;
  isOauthPostLogin: boolean;
  navigate: ReturnType<typeof Route.useNavigate>;
  redirectTo: string;
  status: "created" | "selected";
}) => {
  await invalidateSession.mutateAsync();

  if (!isOauthPostLogin) {
    await navigate({ to: redirectTo, replace: true });
    return;
  }

  const result = await authClient.oauth2.continue({
    ...(status === "created" ? { created: true } : { selected: true }),
    postLogin: true,
  });
  if (result.error) {
    throw toAuthClientError(result.error);
  }

  const redirectUrl = getOauthRedirectUrl(result.data);
  if (!redirectUrl) {
    throw new Error("Missing OAuth continuation redirect URL");
  }

  window.location.href = redirectUrl;
};

const OrganizationList = ({
  isOauthPostLogin,
  organizations,
}: OrganizationListProps) => {
  const t = useTranslations();
  const redirectTo = Route.useSearch({ select: (s) => s.redirectTo });
  const analytics = useAnalytics();
  const navigate = Route.useNavigate();
  const invalidateSession = useInvalidateSession();

  const { isPending: isSelectingOrganization, mutate: selectOrganization } =
    useMutation({
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

        await completeOrganizationFlow({
          invalidateSession,
          isOauthPostLogin,
          navigate,
          redirectTo,
          status: "selected",
        });
      },
      onError: (error) => {
        analytics.captureError(error);
      },
    });

  // Auto-select when there's only one organization
  const singleOrg = organizations.length === 1 ? organizations[0] : null;
  const autoSelected = useRef(false);
  useEffect(() => {
    if (singleOrg && !autoSelected.current && !selectOrganization.isPending) {
      autoSelected.current = true;
      selectOrganization.mutate(singleOrg.id);
    }
  }, [singleOrg, selectOrganization]);

  // Show skeleton while auto-selecting the single org
  if (singleOrg && (selectOrganization.isPending || !autoSelected.current)) {
    return (
      <Frame className="w-full max-w-sm">
        <FrameHeader>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="mt-2 h-4 w-64" />
        </FrameHeader>
        <FramePanel className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full rounded-lg" />
        </FramePanel>
      </Frame>
    );
  }

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{t("auth.selectOrganization")}</FrameTitle>
        <FrameDescription>{t("auth.chooseOrganization")}</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-2">
        {organizations.map((org) => (
          <button
            className="hover:bg-accent/50 flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-start transition-colors disabled:opacity-64"
            disabled={isSelectingOrganization}
            key={org.id}
            onClick={() => selectOrganization(org.id)}
            type="button"
          >
            <Avatar className="size-10">
              <AvatarFallback>
                {org.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium">{org.name}</p>
              <p className="text-muted-foreground text-sm">{org.slug}</p>
            </div>
          </button>
        ))}
      </FramePanel>
    </Frame>
  );
};

const CreateOrganizationForm = ({
  isOauthPostLogin,
}: {
  isOauthPostLogin: boolean;
}) => {
  const t = useTranslations();
  const redirectTo = Route.useSearch({ select: (s) => s.redirectTo });
  const analytics = useAnalytics();
  const navigate = Route.useNavigate();
  const invalidateSession = useInvalidateSession();

  const form = useForm({
    defaultValues: { name: "", slug: "" },
    validators: {
      onDynamic: getOrganizationSchema(),
    },
    onSubmit: async ({ value, formApi }) => {
      const parseResult = v.safeParse(getOrganizationSchema(), value);
      if (!parseResult.success) {
        return;
      }

      const parsedValue = parseResult.output;
      const { data: slugCheckData, error: slugCheckError } =
        await authClient.organization.checkSlug({
          slug: parsedValue.slug,
        });

      if (slugCheckError) {
        analytics.captureError(toAuthClientError(slugCheckError));
        toastManager.add({
          title: slugCheckError.message ?? t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      if (!slugCheckData?.status) {
        formApi.setErrorMap({
          onSubmit: { fields: { slug: t("errors.slugAlreadyTaken") } },
        });
        return;
      }

      const { data, error: createError } = await authClient.organization.create(
        {
          name: parsedValue.name,
          slug: parsedValue.slug,
        },
      );

      if (createError) {
        analytics.captureError(toAuthClientError(createError));
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
        analytics.captureError(toAuthClientError(setActiveError));
        toastManager.add({
          title: setActiveError.message ?? t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      try {
        await completeOrganizationFlow({
          invalidateSession,
          isOauthPostLogin,
          navigate,
          redirectTo,
          status: "created",
        });
      } catch (error) {
        analytics.captureError(error);
        toastManager.add({
          title:
            error instanceof Error ? error.message : t("errors.actionFailed"),
          type: "error",
        });
      }
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
          onSubmit={(event) => {
            event.preventDefault();
            // eslint-disable-next-line typescript/no-floating-promises
            form.handleSubmit();
          }}
        >
          <form.Field name="name">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel>{t("common.organizationName")}</FieldLabel>
                <Input
                  autoFocus
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    const value = event.target.value;
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
                <FieldLabel>{t("common.urlIdentifier")}</FieldLabel>
                <Input
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder={t("common.urlIdentifierPlaceholder")}
                  required
                  value={field.state.value}
                />
                <FieldError />
              </Field>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.isSubmitting}>
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
