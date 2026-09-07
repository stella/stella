import { useLocation } from "@tanstack/react-router";
import { MailIcon, MegaphoneIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";

import { FeedbackCommunityItems } from "@/components/feedback-community-items";
import { buildFeedbackMailto } from "@/components/feedback-dialog.logic";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar";
import { env } from "@/env";
import { sanitizeHref } from "@/lib/sanitize-href";

export const FeedbackDialog = ({ userEmail }: Props) => {
  const t = useTranslations();
  const route = useLocation({
    select: (routeLocation) => routeLocation.pathname,
  });
  const mailto = buildFeedbackMailto({
    recipient: env.VITE_FEEDBACK_EMAIL_TO,
    route,
    userEmail,
  });

  return (
    <SidebarMenuItem>
      <Menu>
        <MenuTrigger
          render={
            <SidebarMenuButton size="sm" tooltip={t("feedback.trigger")} />
          }
        >
          <MegaphoneIcon className="size-4" />
          <span>{t("feedback.trigger")}</span>
        </MenuTrigger>
        <MenuPopup align="start" side="right">
          <FeedbackCommunityItems />
          {mailto && (
            <MenuItem
              render={
                <a aria-label={t("common.email")} href={sanitizeHref(mailto)} />
              }
            >
              <MailIcon />
              {t("common.email")}
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
};

type Props = {
  userEmail?: string | undefined;
};
