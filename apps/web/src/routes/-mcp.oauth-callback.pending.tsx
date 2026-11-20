import type { ComponentProps } from "react";

import { useSearch } from "@tanstack/react-router";

import { ButtonFace } from "@stll/ui/control-face";
import type { OutcomeScreen } from "@stll/ui/outcome-screen";
import { OutcomeScreenPending } from "@stll/ui/outcome-screen";
import { cn } from "@stll/ui/utils";

import { PendingText, useIntlMounted } from "@/components/pending-text";
import type { McpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { framePendingView } from "@/routes/-pending-view.logic";

export const MCP_OAUTH_OUTCOME_LABELS = {
  connected: {
    title: "knowledge.mcp.callbackConnectedTitle",
    description: "knowledge.mcp.callbackConnectedDescription",
    tone: "success",
  },
  error: {
    title: "knowledge.mcp.callbackFailedTitle",
    description: "knowledge.mcp.callbackFailedDescription",
    tone: "error",
  },
} as const satisfies Record<
  McpOAuthOutcome["status"],
  { title: string; description: string; tone: "success" | "error" }
>;

type LoadedScreen = ComponentProps<typeof OutcomeScreen>;
type PendingScreen = ComponentProps<typeof OutcomeScreenPending>;

type McpOAuthCallbackShellProps =
  | { screen: PendingScreen; Screen?: undefined }
  | { screen: LoadedScreen; Screen: typeof OutcomeScreen };

export const McpOAuthCallbackShell = ({
  screen,
  Screen,
}: McpOAuthCallbackShellProps) =>
  Screen === undefined ? (
    <OutcomeScreenPending {...screen} />
  ) : (
    <Screen {...screen} />
  );

const RetryActionsPending = ({ slug }: { slug: string | undefined }) => (
  <>
    <ButtonFace size="default" variant="default">
      <PendingText id="common.tryAgain" />
    </ButtonFace>
    {slug !== undefined && (
      <ButtonFace size="default" variant="outline">
        <PendingText id="knowledge.mcp.openTools" />
      </ButtonFace>
    )}
  </>
);

const OutcomeDescriptionPending = ({
  status,
}: {
  status: McpOAuthOutcome["status"];
}) => {
  const intlMounted = useIntlMounted();
  const text = (
    <PendingText
      barClassName="w-64 max-w-full"
      id={MCP_OAUTH_OUTCOME_LABELS[status].description}
    />
  );
  if (intlMounted) {
    return text;
  }
  return (
    <span
      className={cn(
        "block",
        status === "connected"
          ? "min-h-[1lh] max-[24rem]:min-h-[2lh]"
          : "min-h-[2lh]",
      )}
    >
      {text}
    </span>
  );
};

export const McpOAuthCallbackPending = framePendingView(() => {
  const { connected, slug } = useSearch({
    strict: false,
    select: (search) => ({
      connected: search.status === "connected",
      slug: typeof search.slug === "string" ? search.slug : undefined,
    }),
  });
  const status = connected ? "connected" : "error";
  const { title, tone } = MCP_OAUTH_OUTCOME_LABELS[status];
  return (
    <McpOAuthCallbackShell
      screen={{
        actions: connected ? undefined : <RetryActionsPending slug={slug} />,
        description: <OutcomeDescriptionPending status={status} />,
        title: <PendingText barClassName="w-56 max-w-full" id={title} />,
        tone,
      }}
    />
  );
});
