import { useRef } from "react";

import { useForm } from "@tanstack/react-form";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  Navigate,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { panic } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Avatar, AvatarFallback } from "@stll/ui/components/avatar";
import { Button } from "@stll/ui/components/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/components/field";
import { Form } from "@stll/ui/components/form";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";
import { Input } from "@stll/ui/components/input";
import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import { normalizeOptionalArray } from "@/lib/arrays";
import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors/auth";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import {
  getOauthHashFragment,
  getOauthRedirectUrl,
  getSignedOauthQueryFromHash,
  hasSignedOauthQuery,
} from "@/lib/oauth-provider";
import {
  isAcceptInvitationRedirect,
  normalizeRedirectTo,
} from "@/lib/redirect";
import { toFormErrors } from "@/lib/schema";
import {
  createSlug,
  getOrganizationSchema,
} from "@/routes/_protected.organization/-utils";

const searchSchema = v.object({
  redirectTo: v.optional(v.pipe(v.string(), v.transform(normalizeRedirectTo))),
});

export const Route = createFileRoute("/auth/organization")({
  validateSearch: searchSchema,
  beforeLoad: ({ context, location, search }) => {
    const bridgedQuery = getSignedOauthQueryFromHash(location.hash);

    if (!context.session) {
      if (bridgedQuery) {
        throw redirect({
          href: `/auth#${getOauthHashFragment(bridgedQuery)}`,
          replace: true,
        });
      }

      throw redirect({
        to: "/auth",
        search: {
          redirectTo: location.pathname + location.searchStr,
        },
        replace: true,
      });
    }

    const isOauthPostLogin =
      bridgedQuery !== null || hasSignedOauthQuery(location.searchStr);

    if (
      !isOauthPostLogin &&
      (context.session.activeOrganizationId ||
        isAcceptInvitationRedirect(search.redirectTo ?? "/"))
    ) {
      throw redirect({ to: search.redirectTo ?? "/", replace: true });
    }
  },
  component: Organization,
});

function Organization() {
  const { data: organizations, isPending } = authClient.useListOrganizations();
  const hasOrganizations = (organizations?.length ?? 0) > 0;
  const isOauthPostLogin =
    typeof window !== "undefined" &&
    (getSignedOauthQueryFromHash(window.location.hash) !== null ||
      hasSignedOauthQuery(window.location.search));

  if (!isPending && !hasOrganizations && !isOauthPostLogin) {
    return <Navigate replace to="/onboarding" />;
  }

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
          organizations={normalizeOptionalArray(organizations)}
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
  navigate: ReturnType<typeof useNavigate>;
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
    panic("Missing OAuth continuation redirect URL");
  }

  window.location.href = redirectUrl;
};

const OrganizationList = ({
  isOauthPostLogin,
  organizations,
}: OrganizationListProps) => {
  const t = useTranslations();
  const redirectTo = Route.useSearch({ select: (s) => s.redirectTo ?? "/" });
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const invalidateSession = useInvalidateSession();

  const { isPending: isSelectPending, mutate: selectOrg } = useMutation({
    mutationFn: async (organizationId: string) => {
      const { error } = await authClient.organization.setActive({
        organizationId,
      });

      if (error) {
        stellaToast.add({
          title: userErrorFromThrown(
            toAuthClientError(error),
            t("errors.actionFailed"),
          ),
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
  useExternalSyncEffect(() => {
    if (singleOrg && !autoSelected.current && !isSelectPending) {
      autoSelected.current = true;
      selectOrg(singleOrg.id);
    }
  }, [singleOrg, isSelectPending, selectOrg]);

  // Show skeleton while auto-selecting the single org
  // eslint-disable-next-line react/react-compiler -- one-time guard ref read during render only gates the initial skeleton (before the auto-select effect fires) and the error path; the re-render is driven by singleOrg/isSelectPending
  if (singleOrg && (isSelectPending || !autoSelected.current)) {
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
            disabled={isSelectPending}
            key={org.id}
            onClick={() => selectOrg(org.id)}
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
  const redirectTo = Route.useSearch({ select: (s) => s.redirectTo ?? "/" });
  const analytics = useAnalytics();
  const navigate = useNavigate();
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
        stellaToast.add({
          title: slugCheckError.message ?? t("errors.actionFailed"),
          type: "error",
        });
        return;
      }

      if (!slugCheckData.status) {
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
        stellaToast.add({
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
        stellaToast.add({
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
        stellaToast.add({
          title: userErrorFromThrown(error, t("errors.actionFailed")),
          type: "error",
        });
      }
    },
  });

  const formErrors = useSelector(form.store, (s) => toFormErrors(s.fieldMeta));

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
            void form.handleSubmit();
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
                  dir="ltr"
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
