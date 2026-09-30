import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { MCP_ANONYMIZED_HTTP_PATH, MCP_HTTP_PATH } from "@stll/api-contract";
import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import { BotIcon, CheckIcon, CopyIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
import { stellaToast } from "@stll/ui/toast";

import { getAnalytics } from "@/lib/analytics/provider";
import { externalApiOrigin } from "@/lib/api-origins";
import { detached } from "@/lib/detached";

const COPIED_FEEDBACK_MS = 1600;
const CLI_INSTALL_COMMAND = "npm i -g @stll/cli";

/**
 * The primary way to connect stella: one set of instructions the user pastes
 * into their AI agent (Claude, Codex, Cursor…), which then adds the MCP server,
 * installs the CLI when it can, and verifies the connection. Manual URLs and
 * commands stay available elsewhere as the fallback.
 */
export const AgentSetupPrompt = ({
  variant = "card",
}: {
  /** `card` stands alone (settings); `inline` sits inside a panel that
   *  already has its own title and surface (onboarding). */
  variant?: "card" | "inline";
}) => {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);
  const apiOrigin = externalApiOrigin().replace(/\/$/u, "");
  const instructions = t("agentSetup.instructions", {
    anonymizedUrl: `${apiOrigin}${MCP_ANONYMIZED_HTTP_PATH}`,
    apiOrigin,
    cliInstall: CLI_INSTALL_COMMAND,
    mcpUrl: `${apiOrigin}${MCP_HTTP_PATH}`,
  });

  const copy = async () => {
    const result = await copyToClipboard(instructions);
    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    stellaToast.add({ title: t("agentSetup.copiedToast"), type: "success" });
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, COPIED_FEEDBACK_MS);
  };

  const copyButton = (
    <Button
      className="shrink-0"
      onClick={() => {
        detached(copy(), "agent-setup.copy");
      }}
      size="sm"
      type="button"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {t("agentSetup.copy")}
    </Button>
  );
  const preview = (
    <div className="bg-muted flex max-h-40 flex-col overflow-hidden rounded-lg">
      <ScrollArea axis="vertical">
        <pre
          className="text-muted-foreground p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap"
          dir="auto"
        >
          {instructions}
        </pre>
      </ScrollArea>
    </div>
  );

  if (variant === "inline") {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-foreground text-sm font-medium">
            {t("agentSetup.title")}
          </p>
          {copyButton}
        </div>
        {preview}
      </div>
    );
  }

  return (
    <section
      aria-labelledby="agent-setup-title"
      className="bg-background ring-border flex flex-col gap-3 rounded-xl p-4 shadow-xs/5 ring-1"
    >
      <div className="flex items-start gap-3">
        <div
          aria-hidden="true"
          className="bg-foreground text-background grid size-8 shrink-0 place-items-center rounded-lg"
        >
          <BotIcon className="size-4" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2
            className="text-foreground text-sm font-medium text-balance"
            id="agent-setup-title"
          >
            {t("agentSetup.title")}
          </h2>
          <p className="text-muted-foreground text-xs text-pretty">
            {t("agentSetup.description")}
          </p>
        </div>
        {copyButton}
      </div>
      {preview}
    </section>
  );
};
