import { DiscordLogoIcon, GitHubLogoIcon } from "@stll/ui/brand-icons";
import { MenuItem } from "@stll/ui/menu";

import { COMMUNITY_FORUM_URL } from "@/lib/consts";
import { sanitizeHref } from "@/lib/sanitize-href";

const GITHUB_FEEDBACK_URL =
  "https://github.com/stella/stella/issues/new/choose";

const COMMUNITY_CHANNELS = [
  { name: "Discord", href: COMMUNITY_FORUM_URL, icon: DiscordLogoIcon },
  { name: "GitHub", href: GITHUB_FEEDBACK_URL, icon: GitHubLogoIcon },
] as const;

export const FeedbackCommunityItems = () => (
  <>
    {COMMUNITY_CHANNELS.map(({ name, href, icon: Icon }) => (
      <MenuItem
        key={name}
        render={
          <a
            aria-label={name}
            href={sanitizeHref(href)}
            rel="noreferrer"
            target="_blank"
          />
        }
      >
        <Icon />
        <bdi>{name}</bdi>
      </MenuItem>
    ))}
  </>
);
