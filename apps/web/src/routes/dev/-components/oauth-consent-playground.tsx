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
  Claude: {
    client: { type: "verified", brand: "claude" },
    redirectTargets: ["claude.ai"],
    clientIdHost: "claude.ai",
  },
  ChatGPT: {
    client: { type: "verified", brand: "chatgpt" },
    redirectTargets: ["chatgpt.com"],
    clientIdHost: null,
  },
  "Example connector": {
    client: { type: "unverified", name: "Example connector" },
    redirectTargets: ["connector.example"],
    clientIdHost: null,
  },
} as const satisfies Record<string, OAuthConsentInfo>;

export const OAuthConsentPlayground = () => {
  const t = useTranslations("consent");
  const [info, setInfo] = useState<OAuthConsentInfo>(CLIENTS.Claude);
  const identity = resolveConsentClientIdentity(info, t("defaultClientName"));
  return (
    <section className="w-full" data-playground-section="oauth-consent">
      <div className="flex gap-2 p-2">
        {Object.entries(CLIENTS).map(([label, value]) => (
          <Button
            key={label}
            variant="ghost"
            onClick={() => {
              setInfo(value);
            }}
          >
            {label}
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
