import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { InvitationDeclined } from "@/components/invitation-declined";
import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { toAuthClientError } from "@/lib/errors/auth";
import { transformUnknownError } from "@/lib/errors/client";
import { readQueryResult } from "@/lib/errors/query-result";
import { notifyUserError } from "@/lib/errors/user-toast";

import { InvitationShell } from "./-accept-invitation.pending";
import { InvitationRefusal } from "./-invitation-view";
import type { loadInvitationView } from "./-invitation-view.logic";

const routeApi = getRouteApi("/auth/accept-invitation/$invitationId");

export function InvitationPage() {
  const view = routeApi.useLoaderData();
  const email = routeApi.useRouteContext({ select: (c) => c.signedInEmail });

  if (view.type === "refused") {
    return <InvitationRefusal code={view.code} email={email} />;
  }

  return <AcceptInvitation invitation={view.invitation} />;
}

type AcceptInvitationProps = {
  invitation: Extract<
    Awaited<ReturnType<typeof loadInvitationView>>,
    { type: "invitation" }
  >["invitation"];
};

function AcceptInvitation({ invitation }: AcceptInvitationProps) {
  const invitationId = routeApi.useParams({ select: (p) => p.invitationId });
  const analytics = useAnalytics();
  const navigate = routeApi.useNavigate();
  const invalidateSession = useInvalidateSession();
  const [isDeclined, setIsDeclined] = useState(false);
  const t = useTranslations();

  const acceptInvitation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.acceptInvitation({
        invitationId,
      });

      if (error) {
        const failure = toAuthClientError(error);
        notifyUserError(failure, t("errors.actionFailed"));
        readQueryResult(Result.err(failure));
      }

      const { error: setActiveError } = await authClient.organization.setActive(
        {
          organizationId: invitation.organizationId,
        },
      );

      if (setActiveError) {
        const failure = toAuthClientError(setActiveError);
        notifyUserError(failure, t("errors.actionFailed"));
        readQueryResult(Result.err(failure));
      }

      // Accepting consumed the invitation, so this page's loader would now
      // report it missing: leave the page before the session refresh
      // re-runs the loaders of the matched routes.
      await navigate({ to: "/workspaces", replace: true });
      const refreshed = await Result.tryPromise({
        try: async () => await invalidateSession.mutateAsync(),
        catch: transformUnknownError,
      });
      if (refreshed.isErr()) {
        notifyUserError(refreshed.error, t("errors.actionFailed"));
      }
      readQueryResult(refreshed);
    },
    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "AcceptInvitation:failure",
        scope: { type: "handler", handlerId: "AcceptInvitation:failure" },
      });
    },
  });

  const rejectInvitation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.rejectInvitation({
        invitationId,
      });

      if (error) {
        const failure = toAuthClientError(error);
        notifyUserError(failure, t("errors.actionFailed"));
        readQueryResult(Result.err(failure));
      }

      setIsDeclined(true);
    },

    onError: (error) => {
      analytics.captureError(error, {
        fingerprintKey: "AcceptInvitation:failure-2",
        scope: { type: "handler", handlerId: "AcceptInvitation:failure-2" },
      });
    },
  });

  if (isDeclined) {
    return (
      <InvitationDeclined organizationName={invitation.organizationName} />
    );
  }

  return (
    <InvitationShell
      title={t("auth.invitation.title")}
      description={t("auth.invitation.description", {
        organizationName: invitation.organizationName,
        inviterEmail: invitation.inviterEmail,
        role: invitation.role,
      })}
      primaryAction={
        <Button
          className="w-full"
          disabled={rejectInvitation.isPending}
          disabledReason={t("common.declining")}
          loading={acceptInvitation.isPending}
          onClick={() => acceptInvitation.mutate()}
          type="button"
        >
          {t("common.accept")}
        </Button>
      }
      secondaryAction={
        <Button
          className="w-full"
          disabled={acceptInvitation.isPending}
          disabledReason={t("common.accepting")}
          loading={rejectInvitation.isPending}
          onClick={() => rejectInvitation.mutate()}
          type="button"
          variant="outline"
        >
          {t("common.decline")}
        </Button>
      }
    />
  );
}
