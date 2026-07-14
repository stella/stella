import { useLocation } from "@tanstack/react-router";
import { MailIcon, MegaphoneIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  DiscordLogoIcon,
  GitHubLogoIcon,
} from "@stll/ui/components/brand-icons";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";

import { buildFeedbackMailto } from "@/components/feedback-dialog.logic";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar";
import { env } from "@/env";

export const FeedbackDialog = ({ userEmail }: Props) => {
  const t = useTranslations();
  const route = useLocation({ select: (location) => location.pathname });
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
          <MenuItem
            render={
              <a
                aria-label={t("feedback.discord")}
                href={DISCORD_URL}
                rel="noreferrer"
                target="_blank"
              />
            }
          >
            <DiscordLogoIcon />
            {t("feedback.discord")}
          </MenuItem>
          <MenuItem
            render={
              <a
                aria-label={t("feedback.github")}
                href={GITHUB_FEEDBACK_URL}
                rel="noreferrer"
                target="_blank"
              />
            }
          >
            <GitHubLogoIcon />
            {t("feedback.github")}
          </MenuItem>
          {mailto && (
            <MenuItem
              render={<a aria-label={t("common.email")} href={mailto} />}
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

const DISCORD_URL = "https://discord.gg/8dZjmVFjTK";
const GITHUB_FEEDBACK_URL =
  "https://github.com/stella/stella/issues/new/choose";
