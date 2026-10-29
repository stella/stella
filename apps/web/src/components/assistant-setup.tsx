import type * as React from "react";

import { useTranslations } from "use-intl";

import { MCP_HTTP_PATH } from "@stll/api-contract";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

import { AIProviderIcon } from "@/components/ai-provider-icons";
import { CopyActionButton } from "@/components/copy-action-button";
import { externalApiOrigin } from "@/lib/api-origins";
import { CONNECT_AI_ASSISTANT_DOCS_URL } from "@/lib/consts";

/** Heading anchors on the setup guide, the single source of the steps. */
const GUIDE_ANCHOR = {
  agent: "#instructions-for-ai-agents",
  claude: "#connect-claude",
  generic: "#connect-your-assistant",
} as const;

/**
 * How a person connects stella to the assistant they already use. Written for
 * someone who has never heard of MCP: pick your assistant for the short guide,
 * copy the one address it asks for. Assistants that can configure themselves
 * get a one-line instruction pointing at the same guide. Settings and
 * onboarding render this same component, so the path never diverges.
 */
export const AssistantSetup = ({
  variant = "card",
}: {
  /** `card` stands alone (settings); `inline` sits inside a panel that
   *  already has its own title and surface (onboarding). */
  variant?: "card" | "inline";
}) => {
  const t = useTranslations();
  const mcpUrl = `${externalApiOrigin().replace(/\/$/u, "")}${MCP_HTTP_PATH}`;
  const instructions = t("agentSetup.instructions", {
    guideUrl: `${CONNECT_AI_ASSISTANT_DOCS_URL}${GUIDE_ANCHOR.agent}`,
    mcpUrl,
  });

  const body = (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-sm text-pretty">
        {t("agentSetup.description")}
      </p>
      <div className="flex gap-3">
        <GuideTile
          href={`${CONNECT_AI_ASSISTANT_DOCS_URL}${GUIDE_ANCHOR.claude}`}
          label={t("agentSetup.openGuide", { assistant: "Claude" })}
          name="Claude"
        >
          <AIProviderIcon className="size-5" provider="anthropic" />
        </GuideTile>
        <GuideTile
          href={`${CONNECT_AI_ASSISTANT_DOCS_URL}${GUIDE_ANCHOR.generic}`}
          label={t("agentSetup.openGuide", { assistant: "ChatGPT" })}
          name="ChatGPT"
        >
          <AIProviderIcon className="size-5" provider="openai" />
        </GuideTile>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs">
          {t("agentSetup.addressLabel")}
        </span>
        <div className="bg-muted flex items-center gap-2 rounded-lg py-1 ps-3 pe-1">
          <code
            className="text-foreground min-w-0 flex-1 truncate font-mono text-sm"
            dir="ltr"
          >
            {mcpUrl}
          </code>
          <CopyActionButton size="sm" text={mcpUrl} variant="default" />
        </div>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span>{t("agentSetup.selfSetupHint")}</span>
        <CopyActionButton
          label={t("agentSetup.copy")}
          size="xs"
          text={instructions}
          variant="link"
        />
        <span>{t("agentSetup.pasteHint")}</span>
      </div>
    </div>
  );

  if (variant === "inline") {
    return body;
  }

  return (
    <section
      aria-labelledby="assistant-setup-title"
      className="bg-background ring-border flex flex-col gap-3 rounded-xl p-5 shadow-xs/5 ring-1"
    >
      <h2
        className="text-foreground text-base font-medium text-balance"
        id="assistant-setup-title"
      >
        {t("agentSetup.title")}
      </h2>
      {body}
    </section>
  );
};

const GuideTile = ({
  href,
  label,
  name,
  children,
}: React.PropsWithChildren<{ href: string; label: string; name: string }>) => (
  <a
    aria-label={label}
    className="bg-muted/60 text-foreground hover:bg-muted flex min-h-11 flex-1 items-center justify-center gap-2.5 rounded-xl px-4 py-2.5 text-sm font-medium"
    href={sanitizeHref(href)}
    rel="noreferrer"
    target="_blank"
  >
    {children}
    {name}
  </a>
);
