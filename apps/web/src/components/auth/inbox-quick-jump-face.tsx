import type { ReactElement, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";

import { useIntlMounted } from "@/components/pending-text";

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

export const InboxQuickJumpLayout = ({
  email,
  renderProvider,
}: {
  email: string;
  renderProvider: (provider: Provider, icon: ReactNode) => ReactElement;
}) => (
  <div className="flex flex-wrap justify-center gap-1">
    {getProvidersForEmail(email).map((provider) =>
      renderProvider(provider, <ProviderIcon name={provider.name} />),
    )}
  </div>
);

export const InboxProviderText = ({ name }: { name: ProviderName }) => {
  const t = useTranslations();
  return t("auth.openInProvider", { provider: name });
};

export const InboxQuickJumpPending = ({ email }: { email: string }) => {
  const intlMounted = useIntlMounted();
  return (
    <InboxQuickJumpLayout
      email={email}
      renderProvider={({ name }, icon) => (
        <ButtonFace key={name} size="sm" variant="ghost">
          {icon}
          {intlMounted ? (
            <InboxProviderText name={name} />
          ) : (
            <FaceLabelPending className="w-20" />
          )}
        </ButtonFace>
      )}
    />
  );
};
