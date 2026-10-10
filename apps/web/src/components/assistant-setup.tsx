import type * as React from "react";
import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { MCP_HTTP_PATH } from "@stll/api-contract";
import { copyToClipboard } from "@stll/clipboard";
import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Button } from "@stll/ui/button";
import { CheckIcon, CopyIcon } from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import { AIProviderIcon } from "@/components/ai-provider-icons";
import { getAnalytics } from "@/lib/analytics/provider";
import { externalApiOrigin } from "@/lib/api-origins";
import { CONNECT_AI_ASSISTANT_DOCS_URL } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";

const COPIED_FEEDBACK_MS = 1600;
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
          <CopyTextButton
            label={t("common.copy")}
            text={mcpUrl}
            toast={t("common.copied")}
            variant="default"
          />
        </div>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span>{t("agentSetup.selfSetupHint")}</span>
        <CopyTextButton
          label={t("agentSetup.copy")}
          text={instructions}
          toast={t("agentSetup.copiedToast")}
          variant="link"
        />
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

/** Copies `text`, confirms in place (copy → check) and with a toast. */
const CopyTextButton = ({
  text,
  label,
  toast,
  variant,
}: {
  text: string;
  label: string;
  toast: string;
  variant: "default" | "link";
}) => {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    const result = await copyToClipboard(text);
    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      notifyUserError(result.error, t("errors.actionFailed"));
      return;
    }
    stellaToast.add({ title: toast, type: "success" });
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, COPIED_FEEDBACK_MS);
  };

  return (
    <Button
      onClick={() => {
        detached(copy(), "assistant-setup.copy");
      }}
      size={variant === "link" ? "xs" : "sm"}
      type="button"
      variant={variant}
    >
      {variant === "default" && (copied ? <CheckIcon /> : <CopyIcon />)}
      {label}
    </Button>
  );
};
