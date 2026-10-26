import { useState } from "react";

import { useTranslations } from "use-intl";

import {
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_OAUTH_PROTOCOL_SCOPES,
} from "@stll/api-contract";
import { Button } from "@stll/ui/button";

import { resolveConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import { ConsentCard } from "@/components/oauth-consent/consent-card";
import {
  ConsentAccountRows,
  ConsentDecisionBar,
} from "@/components/oauth-consent/consent-controls";
import { OAuthClientDetails } from "@/components/oauth-consent/oauth-client-details";
import { ScopeSummary } from "@/components/oauth-consent/scope-summary";
import type { OAuthConsentInfo } from "@/lib/oauth-provider";

const CLIENTS = {
  claude: {
    client_name: "Claude",
    redirectTargets: ["claude.ai"],
    clientIdHost: null,
    unverified: false,
    verifiedBrand: "claude",
  },
  chatgpt: {
    client_name: "ChatGPT",
    redirectTargets: ["chatgpt.com"],
    clientIdHost: null,
    unverified: false,
    verifiedBrand: "chatgpt",
  },
  unverified: {
    client_name: "Example connector",
    redirectTargets: ["connector.example"],
    clientIdHost: null,
    unverified: true,
    verifiedBrand: null,
  },
} as const satisfies Record<string, OAuthConsentInfo>;

export const OAuthConsentPlayground = () => {
  const t = useTranslations("consent");
  const [info, setInfo] = useState<OAuthConsentInfo>(CLIENTS.claude);
  const identity = resolveConsentClientIdentity(
    info,
    info.client_name ?? t("defaultClientName"),
  );
  return (
    <section className="w-full" data-playground-section="oauth-consent">
      <div className="flex gap-2 p-2">
        {Object.values(CLIENTS).map((value) => (
          <Button
            key={value.client_name}
            variant="ghost"
            onClick={() => {
              setInfo(value);
            }}
          >
            {value.client_name}
          </Button>
        ))}
      </div>
      <ConsentCard
        identity={identity}
        details={
          <OAuthClientDetails
            info={info}
            clientName={identity.name}
            redirectUri={null}
          />
        }
        decision={
          <ConsentDecisionBar
            allowDisabled={false}
            hasError={false}
            isPending={false}
            onDecide={() => undefined}
          />
        }
      >
        <ConsentAccountRows
          activeOrganizationId="fixture"
          disabled={false}
          email="test@stella.dev"
          onAccountSwitch={() => undefined}
          onOrganizationSwitch={() => undefined}
          organizationName="Harbrook & Partners"
          organizations={undefined}
        />
        <p className="text-muted-foreground -mt-3 text-sm text-pretty">
          {t("actingAs", {
            clientName: identity.name,
            organizationName: "Harbrook & Partners",
          })}
        </p>
        <ScopeSummary
          scopes={[
            ...MCP_DEFAULT_RESOURCE_SCOPES,
            ...MCP_OAUTH_PROTOCOL_SCOPES,
          ]}
        />
        <p className="text-muted-foreground text-xs text-pretty">
          {t("connectionDuration")}
        </p>
      </ConsentCard>
    </section>
  );
};
