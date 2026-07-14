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

import { SidebarMenuButton, SidebarMenuItem } from "@/components/sidebar";
import { env } from "@/env";

type Props = {
  userEmail?: string | undefined;
};

const DISCORD_URL = "https://discord.gg/8dZjmVFjTK";
const DEFAULT_FEEDBACK_EMAIL = "hello@stll.app";
const GITHUB_FEEDBACK_URL =
  "https://github.com/stella/stella/issues/new/choose";

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
  const recipient = env.VITE_FEEDBACK_EMAIL_TO ?? DEFAULT_FEEDBACK_EMAIL;
  const route = typeof window === "undefined" ? "/" : window.location.pathname;

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
          <MenuItem
            render={
              <a
                aria-label={t("common.email")}
                href={buildMailto(recipient, userEmail, route)}
              />
            }
          >
            <MailIcon />
            {t("common.email")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </SidebarMenuItem>
  );
};
