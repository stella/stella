import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { buttonVariants } from "@stll/ui/button";
import { OutcomeScreen } from "@stll/ui/outcome-screen";
import { cn } from "@stll/ui/utils";

import { pageTitleLiteral } from "@/lib/page-title";

/** An invitation, declined: which organization, and the way back to work. */
export const InvitationDeclined = ({
  organizationName,
}: {
  organizationName: string;
}) => {
  const t = useTranslations();
  const title = t("auth.invitation.declined");
  return (
    <OutcomeScreen
      actions={
        <Link
          className={cn(buttonVariants({ variant: "outline" }))}
          to="/workspaces"
        >
          {t("auth.invitation.goToWorkspaces")}
        </Link>
      }
      description={t("auth.invitation.declinedDescription")}
      details={[{ label: t("common.organization"), value: organizationName }]}
      documentTitle={pageTitleLiteral(title)}
      surface="embedded"
      title={title}
      tone="success"
    />
  );
};
