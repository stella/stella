import { useEffect } from "react";

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/components/button";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/components/frame";

import type { McpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { broadcastMcpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { pageTitle } from "@/lib/page-title";

const KNOWLEDGE_MCP_PATH = "/knowledge/mcp";
const FALLBACK_NAVIGATE_DELAY_MS = 150;

const searchSchema = v.object({
  status: v.picklist(["connected", "error"]),
  slug: v.optional(v.string()),
  reason: v.optional(v.string()),
});

export const Route = createFileRoute("/mcp/oauth-callback")({
  validateSearch: searchSchema,
  head: () => ({
    meta: [{ title: pageTitle("knowledge.sections.mcp.title") }],
  }),
  component: McpOAuthCallbackPage,
});

function McpOAuthCallbackPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const status = Route.useSearch({ select: (search) => search.status });
  const reason = Route.useSearch({ select: (search) => search.reason });

  useEffect(() => {
    const outcome: McpOAuthOutcome =
      status === "connected"
        ? { status: "connected" }
        : { status: "error", reason: reason ?? "unexpected" };
    broadcastMcpOAuthOutcome(outcome);
    window.close();
    // `window.close()` is a no-op for tabs the user navigated to
    // themselves (the popup-blocked fallback path uses
    // `window.location.assign`). If we're still here after a tick,
    // route back to the MCP settings page so the user is not stranded.
    const fallback = window.setTimeout(() => {
      void navigate({ to: KNOWLEDGE_MCP_PATH });
    }, FALLBACK_NAVIGATE_DELAY_MS);
    return () => window.clearTimeout(fallback);
  }, [status, reason, navigate]);

  const isError = status === "error";

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Frame className="w-full max-w-sm">
        <FrameHeader>
          <FrameTitle>
            {isError
              ? t("knowledge.mcp.errorTitle")
              : t("knowledge.mcp.connectedToast")}
          </FrameTitle>
          {isError ? (
            <FrameDescription>
              {t("knowledge.mcp.errorDescription")}
            </FrameDescription>
          ) : null}
        </FrameHeader>
        <FramePanel>
          <Button
            className="w-full"
            onClick={() => {
              window.close();
              void navigate({ to: KNOWLEDGE_MCP_PATH });
            }}
            type="button"
          >
            {t("common.close")}
          </Button>
        </FramePanel>
      </Frame>
    </div>
  );
}
