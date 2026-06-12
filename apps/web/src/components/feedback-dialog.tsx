import { MegaphoneIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar";
import { env } from "@/env";

type Props = {
  userEmail?: string | undefined;
};

const buildMailto = (
  recipient: string,
  userEmail: string | undefined,
  route: string,
) => {
  const subject = `Feedback (${route})`;
  const body = [
    "",
    "",
    "---",
    ...(userEmail ? [`From: ${userEmail}`] : []),
    `Route: ${route}`,
  ].join("\n");
  return `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
};

export const FeedbackDialog = ({ userEmail }: Props) => {
  const t = useTranslations();
  const recipient = env.VITE_FEEDBACK_EMAIL_TO;
  if (!recipient) {
    return null;
  }

  const route = typeof window === "undefined" ? "/" : window.location.pathname;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild size="sm" tooltip={t("feedback.trigger")}>
        <a href={buildMailto(recipient, userEmail, route)}>
          <MegaphoneIcon className="size-4" />
          <span>{t("feedback.trigger")}</span>
        </a>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};
