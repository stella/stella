import { useEffect, useRef } from "react";

import { useMutation } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Avatar, AvatarFallback } from "@stella/ui/components/avatar";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stella/ui/components/frame";
import { Skeleton } from "@stella/ui/components/skeleton";
import { toastManager } from "@stella/ui/components/toast";

import { useInvalidateSession } from "@/hooks/use-invalidate-session";
import { useAnalytics } from "@/lib/analytics/provider";
import { authClient } from "@/lib/auth";
import { toAuthClientError } from "@/lib/errors";
import { isAcceptInvitationRedirect, redirectToSchema } from "@/lib/redirect";

const searchSchema = v.strictObject({
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
  const navigate = useNavigate();

  // First-time users (no orgs) go through the onboarding wizard
  useEffect(() => {
    if (!isPending && !hasOrgs) {
      // eslint-disable-next-line typescript/no-floating-promises
      navigate({ to: "/onboarding", replace: true });
    }
  }, [isPending, hasOrgs, navigate]);

  if (isPending || !hasOrgs) {
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

  return <OrganizationList organizations={organizations} />;
}

type OrganizationListProps = {
  organizations: { id: string; name: string; slug: string }[];
};

const OrganizationList = ({ organizations }: OrganizationListProps) => {
  const t = useTranslations();
  const { redirectTo } = Route.useSearch();
  const analytics = useAnalytics();
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
      analytics.captureError(error);
    },
  });

  // Auto-select when there's only one organization
  const autoSelected = useRef(false);
  useEffect(() => {
    if (
      organizations.length === 1 &&
      !autoSelected.current &&
      !selectOrganization.isPending
    ) {
      autoSelected.current = true;
      // SAFETY: length === 1 check above guarantees index 0 exists
      selectOrganization.mutate(organizations.at(0)?.id ?? "");
    }
  }, [organizations, selectOrganization]);

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
              <p className="text-muted-foreground text-sm">{org.slug}</p>
            </div>
          </button>
        ))}
      </FramePanel>
    </Frame>
  );
};
