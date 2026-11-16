import { useState } from "react";

import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button, buttonVariants } from "@stll/ui/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { cn } from "@stll/ui/utils";

import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth-client";
import { toAuthClientError } from "@/lib/errors/auth";
import { notifyUserError } from "@/lib/errors/user-toast";

import { InvitationRefusal, loadInvitationView } from "./-invitation-view";

export const Route = createFileRoute("/auth/accept-invitation/$invitationId")({
  beforeLoad: ({ context, location }) => {
    if (!context.session || !context.user) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: location.pathname },
        replace: true,
      });
    }
    return { signedInEmail: context.user.email };
  },
  loader: async ({ params }) => {
    const view = await loadInvitationView(params.invitationId);

    if (view.type === "missing") {
      throw notFound();
    }

    return view;
  },
  component: InvitationPage,
});

function InvitationPage() {
  const view = Route.useLoaderData();
  const email = Route.useRouteContext({ select: (c) => c.signedInEmail });

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
  const invitationId = Route.useParams({ select: (p) => p.invitationId });
  const analytics = useAnalytics();
  const navigate = Route.useNavigate();
  const invalidateSession = useInvalidateSession();
  const [isDeclined, setIsDeclined] = useState(false);
  const t = useTranslations();

  const acceptInvitation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.acceptInvitation({
        invitationId,
      });

      if (error) {
        notifyUserError(toAuthClientError(error), t("errors.actionFailed"));
        throw toAuthClientError(error);
      }

      const { error: setActiveError } = await authClient.organization.setActive(
        {
          organizationId: invitation.organizationId,
        },
      );

      if (setActiveError) {
        notifyUserError(
          toAuthClientError(setActiveError),
          t("errors.actionFailed"),
        );
        throw toAuthClientError(setActiveError);
      }

      await invalidateSession.mutateAsync();
      await navigate({ to: "/workspaces", replace: true });
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
        notifyUserError(toAuthClientError(error), t("errors.actionFailed"));
        throw toAuthClientError(error);
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
    return <DeclinedState />;
  }

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{t("auth.invitation.title")}</FrameTitle>
        <FrameDescription>
          {t("auth.invitation.description", {
            organizationName: invitation.organizationName,
            inviterEmail: invitation.inviterEmail,
            role: invitation.role,
          })}
        </FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-2">
        <Button
          className="w-full"
          disabled={rejectInvitation.isPending}
          loading={acceptInvitation.isPending}
          onClick={() => acceptInvitation.mutate()}
          type="button"
        >
          {t("common.accept")}
        </Button>
        <Button
          className="w-full"
          disabled={acceptInvitation.isPending}
          loading={rejectInvitation.isPending}
          onClick={() => rejectInvitation.mutate()}
          type="button"
          variant="outline"
        >
          {t("common.decline")}
        </Button>
      </FramePanel>
    </Frame>
  );
}

const DeclinedState = () => {
  const t = useTranslations();

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{t("auth.invitation.declined")}</FrameTitle>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        <FrameDescription>
          {t("auth.invitation.declinedDescription")}
        </FrameDescription>
        <Link
          className={cn(buttonVariants({ variant: "default" }), "w-full")}
          to="/workspaces"
        >
          {t("auth.invitation.goToWorkspaces")}
        </Link>
      </FramePanel>
    </Frame>
  );
};
