import { useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  MCP_DEFAULT_RESOURCE_SCOPES,
  MCP_OAUTH_PROTOCOL_SCOPES,
} from "@stll/api-contract";
import { Button } from "@stll/ui/button";

import { InvitationDeclined } from "@/components/invitation-declined";
import { resolveConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import type { OAuthConsentInfo } from "@/lib/oauth-provider";
import { AgentClaimConnected } from "@/routes/-agent-claim-connected";
import { ConsentSuccessScreen } from "@/routes/-consent-success";
import { McpOAuthOutcomeScreen } from "@/routes/-mcp-oauth-outcome";

const ORGANIZATION = "Harbrook & Partners";

const CLAUDE = {
  client: { type: "verified", brand: "claude" },
  redirectTargets: ["claude.ai"],
  clientIdHost: "claude.ai",
} as const satisfies OAuthConsentInfo;

/** Every web flow's outcome screen, as its route renders it. */
const FLOWS = [
  { flow: "consent", label: "Consent connected" },
  { flow: "agent", label: "Agent connected" },
  { flow: "mcp-connected", label: "Integration connected" },
  { flow: "mcp-failed", label: "Integration not connected" },
  { flow: "invitation", label: "Invitation declined" },
] as const;

type Flow = (typeof FLOWS)[number]["flow"];

const FlowScreen = ({ flow }: { flow: Flow }) => {
  const t = useTranslations("consent");
  switch (flow) {
    case "consent":
      return (
        <ConsentSuccessScreen
          identity={resolveConsentClientIdentity(
            CLAUDE,
            t("defaultClientName"),
          )}
          organizationName={ORGANIZATION}
          scopes={[
            ...MCP_DEFAULT_RESOURCE_SCOPES,
            ...MCP_OAUTH_PROTOCOL_SCOPES,
          ]}
        />
      );
    case "agent":
      return <AgentClaimConnected organizationName={ORGANIZATION} />;
    case "mcp-connected":
      return (
        <McpOAuthOutcomeScreen
          outcome={{ status: "connected" }}
          slug="linear"
        />
      );
    case "mcp-failed":
      return (
        <McpOAuthOutcomeScreen
          outcome={{ status: "error", reason: "token-exchange" }}
          slug="linear"
        />
      );
    case "invitation":
      return (
        <div className="flex justify-center px-4">
          <InvitationDeclined organizationName={ORGANIZATION} />
        </div>
      );
    default:
      flow satisfies never;
      return panic("Unhandled outcome fixture flow");
  }
};

export const OutcomeScreenPlayground = () => {
  const [flow, setFlow] = useState<Flow>("consent");
  return (
    <section className="w-full" data-playground-section="outcome-screen">
      <div className="flex flex-wrap gap-1 px-2">
        {FLOWS.map(({ flow: value, label }) => (
          <Button
            aria-pressed={flow === value}
            data-flow={value}
            key={value}
            onClick={() => {
              setFlow(value);
            }}
            size="sm"
            variant={flow === value ? "secondary" : "ghost"}
          >
            {label}
          </Button>
        ))}
      </div>
      <FlowScreen flow={flow} />
    </section>
  );
};
