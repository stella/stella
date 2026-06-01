import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";

import { sanitizeHref } from "@/lib/sanitize-href";

type ProviderName =
  | "Gmail"
  | "Outlook"
  | "iCloud"
  | "Yahoo"
  | "Proton Mail"
  | "Fastmail";

type Provider = {
  readonly name: ProviderName;
  readonly url: string;
  readonly domains: readonly string[];
};

const PROVIDERS: readonly Provider[] = [
  {
    name: "Gmail",
    url: "https://mail.google.com/mail/u/0/#inbox",
    domains: ["gmail.com", "googlemail.com"],
  },
  {
    name: "Outlook",
    url: "https://outlook.live.com/mail/0/inbox",
    domains: ["outlook.com", "hotmail.com", "live.com", "msn.com"],
  },
  {
    name: "iCloud",
    url: "https://www.icloud.com/mail",
    domains: ["icloud.com", "me.com", "mac.com"],
  },
  {
    name: "Yahoo",
    url: "https://mail.yahoo.com",
    domains: ["yahoo.com", "ymail.com"],
  },
  {
    name: "Proton Mail",
    url: "https://mail.proton.me/u/0/inbox",
    domains: ["proton.me", "protonmail.com", "pm.me"],
  },
  {
    name: "Fastmail",
    url: "https://app.fastmail.com/mail/Inbox",
    domains: ["fastmail.com", "fastmail.fm"],
  },
];

// Most corporate domains run on Workspace or M365, so a generic email
// from a custom domain gets the two best-guess buttons.
const isFallbackProvider = (name: ProviderName) =>
  name === "Gmail" || name === "Outlook";

const getProductIconUrl = (name: ProviderName) => {
  if (name === "Gmail") {
    return "https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg";
  }

  if (name === "Outlook") {
    return "https://upload.wikimedia.org/wikipedia/commons/c/cc/Microsoft_Outlook_Icon_%282025%E2%80%93present%29.svg";
  }

  return null;
};

const ProviderIcon = ({ name }: { name: ProviderName }) => {
  const iconUrl = getProductIconUrl(name);
  if (!iconUrl) {
    return null;
  }

  return <img alt="" className="size-4" src={iconUrl} />;
};

const getProvidersForEmail = (email: string): readonly Provider[] => {
  const domain = email.split("@").at(1)?.toLowerCase() ?? "";
  const exact = PROVIDERS.find((p) => p.domains.includes(domain));
  if (exact) {
    return [exact];
  }
  return PROVIDERS.filter((p) => isFallbackProvider(p.name));
};

export const InboxQuickJump = ({ email }: { email: string }) => {
  const t = useTranslations();
  const providers = getProvidersForEmail(email);
  return (
    <div className="flex flex-wrap justify-center gap-1">
      {providers.map((p) => (
        <Button
          key={p.name}
          render={
            <a
              href={sanitizeHref(p.url)}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ProviderIcon name={p.name} />
              {t("auth.openInProvider", { provider: p.name })}
            </a>
          }
          size="sm"
          variant="ghost"
        />
      ))}
    </div>
  );
};
