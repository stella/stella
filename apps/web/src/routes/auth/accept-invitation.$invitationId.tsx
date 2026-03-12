import { useState } from "react";

import { usePostHog } from "@posthog/react";
import { useMutation } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  notFound,
  redirect,
} from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button, buttonVariants } from "@stella/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stella/ui/components/frame";
import { toastManager } from "@stella/ui/components/toast";
import { cn } from "@stella/ui/lib/utils";

import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { captureError } from "@/lib/posthog/utils";

export const Route = createFileRoute("/auth/accept-invitation/$invitationId")({
  beforeLoad: ({ context, location }) => {
    if (!context.session) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: location.pathname },
        replace: true,
      });
    }
  },
  loader: async ({ params }) => {
    const { data, error } = await authClient.organization.getInvitation({
      query: { id: params.invitationId },
    });

    if (
      (error !== undefined && error !== null) ||
      data === undefined ||
      data === null
    ) {
      throw notFound();
    }

    if (data.status !== "pending") {
      throw notFound();
    }

    return { invitation: data };
  },
  component: AcceptInvitation,
});

function AcceptInvitation() {
  const { invitationId } = Route.useParams();
  const { invitation } = Route.useLoaderData();
  const posthog = usePostHog();
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
        toastManager.add({
          title: error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(error);
      }

      const { error: setActiveError } = await authClient.organization.setActive(
        {
          organizationId: invitation.organizationId,
        },
      );

      if (setActiveError) {
        toastManager.add({
          title: setActiveError.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(setActiveError);
      }

      await invalidateSession.mutateAsync();
      await navigate({ to: "/workspaces", replace: true });
    },
    onError: (error) => {
      captureError(posthog, error);
    },
  });

  const rejectInvitation = useMutation({
    mutationFn: async () => {
      const { error } = await authClient.organization.rejectInvitation({
        invitationId,
      });

      if (error) {
        toastManager.add({
          title: error.message ?? t("errors.actionFailed"),
          type: "error",
        });
        throw toAuthClientError(error);
      }

      setIsDeclined(true);
    },

    onError: (error) => {
      captureError(posthog, error);
    },
  });

  if (isDeclined) {
    return <DeclinedState />;
  }

  return (
    <div className="flex flex-1 items-center justify-center">
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
    </div>
  );
}

const DeclinedState = () => {
  const t = useTranslations();

  return (
    <div className="flex flex-1 items-center justify-center">
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
    </div>
  );
};
