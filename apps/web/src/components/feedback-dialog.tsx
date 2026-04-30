import { MegaphoneIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar";
import { env } from "@/env";

type Props = {
  userEmail: string;
};

const buildMailto = (recipient: string, userEmail: string, route: string) => {
  const subject = `Feedback (${route})`;
  const body = ["", "", "---", `From: ${userEmail}`, `Route: ${route}`].join(
    "\n",
  );
  return `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
};

export const FeedbackDialog = ({ userEmail }: Props) => {
  const t = useTranslations();
  const recipient = env.VITE_FEEDBACK_EMAIL_TO;
  if (!recipient) {
    return null;
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild size="sm" tooltip={t("feedback.trigger")}>
        <a href={buildMailto(recipient, userEmail, window.location.pathname)}>
          <MegaphoneIcon className="size-4" />
          <span>{t("feedback.trigger")}</span>
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};
