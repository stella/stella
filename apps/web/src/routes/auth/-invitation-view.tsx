import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button, buttonVariants } from "@stll/ui/button";
import { FrameDescription } from "@stll/ui/frame";
import { cn } from "@stll/ui/utils";

import { useSignOut } from "@/hooks/use-sign-out";

import { InvitationShell } from "./-accept-invitation.pending";
import { INVITATION_REFUSALS } from "./-invitation-view.logic";
import type { InvitationRefusalCode } from "./-invitation-view.logic";

type InvitationRefusalProps = {
  code: InvitationRefusalCode;
  email: string;
};

export const InvitationRefusal = ({ code, email }: InvitationRefusalProps) => {
  const t = useTranslations();
  const { isPending, mutate: signOut } = useSignOut();
  const { nextStep, reason } = INVITATION_REFUSALS[code];

  return (
    <InvitationShell
      title={t("auth.invitation.title")}
      description={t(reason)}
      guidance={<FrameDescription>{t(nextStep, { email })}</FrameDescription>}
      primaryAction={
        <Button
          className="w-full"
          loading={isPending}
          onClick={() => signOut()}
          type="button"
        >
          {t("common.signOut")}
        </Button>
      }
      secondaryAction={
        <Link
          className={cn(buttonVariants({ variant: "outline" }), "w-full")}
          to="/workspaces"
        >
          {t("auth.invitation.goToWorkspaces")}
        </Link>
      }
    />
  );
};
