import * as React from "react";
import { useRef } from "react";

import { useForm, useSelector } from "@tanstack/react-form";
import {
  type QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getRouteApi,
  Navigate,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { Avatar, AvatarFallback } from "@stll/ui/avatar";
import { Button } from "@stll/ui/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { getInitials } from "@stll/ui/initials";
import { Input } from "@stll/ui/input";

import { OAuthAccountList } from "@/components/oauth-consent/consent-control-faces.pending";
import {
  OAuthAccountRow,
  useOAuthAccountSwitch,
} from "@/components/oauth-consent/oauth-account";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useHydrated } from "@/hooks/use-hydrated";
import { useSingleFlight } from "@/hooks/use-single-flight";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { refreshAuthQueries } from "@/lib/auth-queries";
import { invokeCapability } from "@/lib/capabilities/capability-request";
import { detached } from "@/lib/detached";
import { unwrapApiResponse } from "@/lib/errors/api";
import { toAuthClientError } from "@/lib/errors/auth";
import { transformUnknownError } from "@/lib/errors/client";
import { readQueryResult } from "@/lib/errors/query-result";
import {
  notifyAuthClientError,
  notifyUserError,
} from "@/lib/errors/user-toast";
import { useIdempotentSubmit } from "@/lib/idempotency/use-idempotent-submit";
import {
  getOauthRedirectUrl,
  getSignedOauthQuery,
  hasOauthPrompt,
} from "@/lib/oauth-provider";
import { organizationListOptions } from "@/lib/organization/queries";
import { getOrganizationSchema } from "@/lib/organization/utils";
import { queryView } from "@/lib/query-view.logic";
import { destinationNavigation, onboardingNavigation } from "@/lib/redirect";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";

import {
  OrganizationPageShell,
  OrganizationPending,
  OrganizationPendingBody,
  OrganizationPickerShell,
  OrganizationRowFace,
} from "./-organization.pending";

const routeApi = getRouteApi("/auth/organization");

const DevQuickStartContinuation = import.meta.env.DEV
  ? React.lazy(async () => {
      const module =
        await import("@/routes/auth/-components/dev-quick-start-button");
      return { default: module.DevQuickStartContinuation };
    })
  : null;

export function OrganizationPage() {
  const hydrated = useHydrated();
  const { devQuickStart, redirectTo } = routeApi.useSearch({
    select: (search) => ({
      devQuickStart: search.devQuickStart,
      redirectTo: search.redirectTo ?? "/",
    }),
  });

  if (import.meta.env.DEV && devQuickStart && hydrated) {
    if (DevQuickStartContinuation === null) {
      return null;
    }
    return (
      <React.Suspense fallback={<OrganizationPending />}>
        <DevQuickStartContinuation redirectTo={redirectTo} />
      </React.Suspense>
    );
  }

  if (!hydrated && import.meta.env.DEV && devQuickStart) {
    return <OrganizationPending />;
  }

  return <OrganizationFlow hydrated={hydrated} />;
}

const OrganizationFlow = ({ hydrated }: { hydrated: boolean }) => {
  const userId = routeApi.useRouteContext({ select: (ctx) => ctx.userId });
  const organizationView = queryView(useQuery(organizationListOptions(userId)));
  const redirectTo = routeApi.useSearch({
    select: (search) => search.redirectTo,
  });
  // Read from the router, never from `window.location` during render: this
  // page stays mounted when a navigation only changes its query or fragment,
  // and a value read outside React's inputs keeps its first answer.
  const signedOauthQuery = useLocation({
    select: ({ hash, searchStr }) => getSignedOauthQuery({ hash, searchStr }),
  });
  const isOauthPostLogin = signedOauthQuery !== null;
  // A client asking for account selection gets this step even for a single
  // membership, so the account can still be switched before consent.
  const isAccountSelection = hasOauthPrompt(signedOauthQuery, "select_account");

  if (hydrated && organizationView.type === "empty" && !isOauthPostLogin) {
    return <Navigate {...onboardingNavigation(redirectTo)} />;
  }

  if (!hydrated || organizationView.type === "pending") {
    return <OrganizationPending />;
  }

  if (
    organizationView.type === "error" ||
    (organizationView.type === "items" && organizationView.items.length === 0)
  ) {
    return (
      <Frame className="w-full max-w-sm">
        <FramePanel>
          <QueryViewFeedback view={organizationView} />
        </FramePanel>
      </Frame>
    );
  }

  return (
    <OrganizationPageShell>
      <QueryViewFeedback view={organizationView} />
      {organizationView.type === "items" ? (
        <OrganizationList
          isAccountSelection={isAccountSelection}
          isOauthPostLogin={isOauthPostLogin}
          organizations={organizationView.items}
        />
      ) : (
        <CreateOrganizationForm isOauthPostLogin={isOauthPostLogin} />
      )}
    </OrganizationPageShell>
  );
};

/**
 * Who the organizations below belong to, with the same switch the consent step
 * offers: signing in as someone else resumes the same authorization request.
 */
const SignedInAccount = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslations();
  const email = routeApi.useRouteContext({ select: (ctx) => ctx.user?.email });
  const switchAccount = useOAuthAccountSwitch();
  const { isPending, mutate } = useMutation({
    mutationFn: switchAccount,
    onSuccess: (outcome) => {
      if (outcome.isErr()) {
        notifyUserError(outcome.error, t("errors.actionFailed"));
      }
    },
  });

  if (!email) {
    return null;
  }

  return (
    <div className="mt-3">
      <OAuthAccountList>
        <OAuthAccountRow
          disabled={disabled || isPending}
          email={email}
          onAccountSwitch={() => {
            mutate();
          }}
        />
      </OAuthAccountList>
    </div>
  );
};

type OrganizationListProps = {
  isAccountSelection: boolean;
  isOauthPostLogin: boolean;
  organizations: { id: string; name: string; slug: string }[];
};

const completeOrganizationFlow = async ({
  isOauthPostLogin,
  navigate,
  queryClient,
  redirectTo,
  status,
}: {
  isOauthPostLogin: boolean;
  navigate: ReturnType<typeof useNavigate>;
  queryClient: QueryClient;
  redirectTo: string;
  status: "created" | "selected";
}) => {
  const completion = await Result.tryPromise({
    try: async () => {
      // Refresh the auth caches without invalidating this route, which exits
      // when the session exposes an active organization.
      await refreshAuthQueries(queryClient);
      if (!isOauthPostLogin) {
        await navigate(destinationNavigation(redirectTo));
        return Result.ok(undefined);
      }

      const result = await authClient.oauth2.continue({
        ...(status === "created" ? { created: true } : { selected: true }),
        postLogin: true,
      });
      if (result.error) {
        return Result.err(toAuthClientError(result.error));
      }

      const redirectUrl = getOauthRedirectUrl(result.data);
      if (!redirectUrl) {
        panic("Missing OAuth continuation redirect URL");
      }

      window.location.href = redirectUrl;
      return Result.ok(undefined);
    },
    catch: transformUnknownError,
  });
  return completion.isErr() ? completion : completion.value;
};

const OrganizationList = ({
  isAccountSelection,
  isOauthPostLogin,
  organizations,
}: OrganizationListProps) => {
  const t = useTranslations();
  const redirectTo = routeApi.useSearch({ select: (s) => s.redirectTo ?? "/" });
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { isPending: isSelectPending, mutate: selectOrg } = useMutation({
    mutationFn: async (organizationId: string) => {
      const { error } = await authClient.organization.setActive({
        organizationId,
      });

      if (error) {
        const authError = toAuthClientError(error);
        notifyUserError(authError, t("errors.actionFailed"));
        return readQueryResult(Result.err(authError));
      }

      const refreshed = await completeOrganizationFlow({
        isOauthPostLogin,
        navigate,
        queryClient,
        redirectTo,
        status: "selected",
      });
      if (refreshed.isErr()) {
        notifyUserError(refreshed.error, t("errors.actionFailed"));
      }
      return readQueryResult(refreshed);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "OrganizationList:failure",
        scope: { type: "handler", handlerId: "OrganizationList:failure" },
      });
    },
  });

  // Auto-select when there is only one organization, unless the client asked
  // for account selection.
  const singleOrg =
    organizations.length === 1 && !isAccountSelection ? organizations[0] : null;
  const autoSelected = useRef(false);
  useExternalSyncEffect(() => {
    if (singleOrg && !autoSelected.current && !isSelectPending) {
      autoSelected.current = true;
      selectOrg(singleOrg.id);
    }
  }, [singleOrg, isSelectPending, selectOrg]);

  // Show skeleton while auto-selecting the single org
  // oxlint-disable-next-line react/refs -- one-time guard ref read during render only gates the initial skeleton (before the auto-select effect fires) and the error path; the re-render is driven by singleOrg/isSelectPending
  if (singleOrg && (isSelectPending || !autoSelected.current)) {
    return <OrganizationPendingBody rowCount={1} />;
  }

  return (
    <OrganizationPickerShell
      account={<SignedInAccount disabled={isSelectPending} />}
    >
      {organizations.map((org) => (
        <Button
          className="w-full"
          disabled={isSelectPending}
          disabledReason={t("common.switchingOrganization")}
          key={org.id}
          onClick={() => selectOrg(org.id)}
          variant="plain"
        >
          <OrganizationRowFace dimmed={isSelectPending}>
            <Avatar className="size-10">
              <AvatarFallback>{getInitials(org.name)}</AvatarFallback>
            </Avatar>
            <span>
              <span className="block font-medium">{org.name}</span>
              <span className="text-muted-foreground block text-sm">
                {org.slug}
              </span>
            </span>
          </OrganizationRowFace>
        </Button>
      ))}
    </OrganizationPickerShell>
  );
};

const CreateOrganizationForm = ({
  isOauthPostLogin,
}: {
  isOauthPostLogin: boolean;
}) => {
  const t = useTranslations();
  const redirectTo = routeApi.useSearch({ select: (s) => s.redirectTo ?? "/" });
  const analytics = useAnalytics();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const createIntent = useIdempotentSubmit();
  const creationFlight = useSingleFlight();

  const form = useForm(
    schemaFormOptions({
      schema: getOrganizationSchema(),
      defaultValues: { name: "", slug: "" },
      submitValues: "schema-output",
      onSubmit: async ({ value }) => {
        const createResult = await Result.tryPromise({
          try: async () =>
            await invokeCapability("organizations.create", async (request) =>
              unwrapApiResponse(
                await api.organizations.post(
                  {
                    name: value.name,
                    ...(value.slug === undefined ? {} : { slug: value.slug }),
                  },
                  {
                    ...request,
                    headers: {
                      "Idempotency-Key": createIntent.prepare({
                        body: value,
                        operation: "organizations.create",
                      }).headers["Idempotency-Key"],
                      ...request.headers,
                    },
                  },
                ),
              ),
            ),
          catch: (error) => error,
        });

        if (Result.isError(createResult)) {
          analytics.captureError(createResult.error, {
            fingerprintKey: "CreateOrganizationForm.onSubmit:failure-2",
            scope: {
              type: "handler",
              handlerId: "CreateOrganizationForm.onSubmit:failure-2",
            },
          });
          notifyUserError(createResult.error, t("errors.actionFailed"));
          return;
        }
        const data = createResult.value;

        const { error: setActiveError } =
          await authClient.organization.setActive({
            organizationId: data.organizationId,
          });

        if (setActiveError) {
          analytics.captureError(toAuthClientError(setActiveError), {
            fingerprintKey: "CreateOrganizationForm.onSubmit:failure-3",
            scope: {
              type: "handler",
              handlerId: "CreateOrganizationForm.onSubmit:failure-3",
            },
          });
          notifyAuthClientError(setActiveError, t("errors.actionFailed"));
          return;
        }

        const completion = await completeOrganizationFlow({
          isOauthPostLogin,
          navigate,
          queryClient,
          redirectTo,
          status: "created",
        });
        if (completion.isErr()) {
          analytics.captureError(completion.error, {
            fingerprintKey: "CreateOrganizationForm.onSubmit:failure-4",
            scope: {
              type: "handler",
              handlerId: "CreateOrganizationForm.onSubmit:failure-4",
            },
          });
          notifyUserError(completion.error, t("errors.actionFailed"));
        }
      },
    }),
  );

  const formErrors = useSelector(form.store, (s) => toFormErrors(s.fieldMeta));

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{t("auth.createOrganization")}</FrameTitle>
        <FrameDescription>{t("auth.createFirstOrganization")}</FrameDescription>
        <SignedInAccount disabled={false} />
      </FrameHeader>
      <FramePanel>
        <Form
          errors={formErrors}
          onSubmit={(event) => {
            event.preventDefault();
            detached(
              creationFlight.run(async () => await form.handleSubmit()),
              "auth-organization.submit",
            );
          }}
        >
          <form.Field name="name">
            {(field) => (
              <Field name={field.name}>
                <FieldLabel>{t("common.organizationName")}</FieldLabel>
                <Input
                  autoFocus
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
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
