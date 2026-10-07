import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { sanitizeHref } from "@/lib/sanitize-href";

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

type ProviderShape = {
  readonly name: string;
  readonly url: string;
  readonly domains: readonly string[];
};

export const PROVIDERS = [
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
] as const satisfies readonly ProviderShape[];

type ProviderName = (typeof PROVIDERS)[number]["name"];
type Provider = Omit<ProviderShape, "name"> & { readonly name: ProviderName };

// Most corporate domains run on Workspace or M365, so a generic email
// from a custom domain gets the two best-guess buttons.
const isFallbackProvider = (name: ProviderName) =>
  name === "Gmail" || name === "Outlook";

// Self-hosted so the sign-in page never tells a third party which
// inbox the visitor uses. A provider without an accurate official mark
// maps to null; the Record keeps every provider listed here.
export const PROVIDER_ICON_URLS = {
  Gmail: "/branding/mail/gmail.svg",
  Outlook: "/branding/apps/microsoft-outlook.svg",
  iCloud: "/branding/mail/icloud.svg",
  Yahoo: null,
  "Proton Mail": "/branding/mail/proton-mail.svg",
  Fastmail: null,
} as const satisfies Record<ProviderName, `/branding/${string}.svg` | null>;

const ProviderIcon = ({ name }: { name: ProviderName }) => {
  const iconUrl = PROVIDER_ICON_URLS[name];
  if (!iconUrl) {
    return null;
  }

  return <img alt="" className="size-4" src={iconUrl} />;
};

const getProvidersForEmail = (email: string): readonly Provider[] => {
  const domain = email.split("@").at(1)?.toLowerCase() ?? "";
  const exact = PROVIDERS.find((provider) =>
    provider.domains.some((providerDomain) => providerDomain === domain),
  );
  if (exact) {
    return [exact];
  }
  return PROVIDERS.filter((p) => isFallbackProvider(p.name));
};
