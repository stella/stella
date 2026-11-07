import { Link } from "@tanstack/react-router";
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

import { useSignOut } from "@/hooks/use-sign-out";
import type { TranslationKey } from "@/i18n/types";
import { authClient } from "@/lib/auth-client";

/** The two answers where the next step is signing in differently. */
const INVITATION_REFUSALS = {
  EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: {
    reason: "errors.apiCodes.invitationEmailUnverified",
    nextStep: "auth.invitation.verifyEmailHint",
  },
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: {
    reason: "errors.apiCodes.invitationOtherRecipient",
    nextStep: "auth.invitation.wrongAccountHint",
  },
} as const satisfies Record<
  string,
  { reason: TranslationKey; nextStep: TranslationKey }
>;

type InvitationRefusalCode = keyof typeof INVITATION_REFUSALS;

const isInvitationRefusalCode = (
  code: string | undefined,
): code is InvitationRefusalCode =>
  code !== undefined && Object.hasOwn(INVITATION_REFUSALS, code);

/** An invitation this account may answer, why the server refused to show it, or nothing to show. */
export const loadInvitationView = async (invitationId: string) => {
  const { data, error } = await authClient.organization.getInvitation({
    query: { id: invitationId },
  });

  if (isInvitationRefusalCode(error?.code)) {
    return { type: "refused", code: error.code } as const;
  }

  if (data?.status !== "pending") {
    return { type: "missing" } as const;
  }

  return { type: "invitation", invitation: data } as const;
};

type InvitationRefusalProps = {
  code: InvitationRefusalCode;
  email: string;
};

export const InvitationRefusal = ({ code, email }: InvitationRefusalProps) => {
  const t = useTranslations();
  const { isPending, mutate: signOut } = useSignOut();
  const { nextStep, reason } = INVITATION_REFUSALS[code];

  return (
    <Frame className="w-full max-w-sm">
      <FrameHeader>
        <FrameTitle>{t("auth.invitation.title")}</FrameTitle>
        <FrameDescription>{t(reason)}</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        <FrameDescription>{t(nextStep, { email })}</FrameDescription>
        <div className="flex flex-col gap-2">
          <Button
            className="w-full"
            loading={isPending}
            onClick={() => signOut()}
            type="button"
          >
            {t("common.signOut")}
          </Button>
          <Link
            className={cn(buttonVariants({ variant: "outline" }), "w-full")}
            to="/workspaces"
          >
            {t("auth.invitation.goToWorkspaces")}
          </Link>
        </div>
      </FramePanel>
    </Frame>
  );
};
