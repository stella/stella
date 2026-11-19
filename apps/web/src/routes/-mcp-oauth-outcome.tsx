import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button, buttonVariants } from "@stll/ui/button";
import { OutcomeScreen } from "@stll/ui/outcome-screen";
import type { OutcomeCloseTab } from "@stll/ui/outcome-screen";
import { cn } from "@stll/ui/utils";

import { mcpConnectorConnection } from "@/lib/api";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { McpOAuthOutcome } from "@/lib/mcp-oauth-channel";
import { useMcpOAuthWindow } from "@/lib/mcp-oauth-channel";
import { pageTitleLiteral } from "@/lib/page-title";
import { resourceMutation } from "@/lib/workspace-realtime";

/** Where integrations are connected and managed. */
export const MCP_TOOLS_PATH = "/knowledge/tools";

/**
 * A failed sign-in's way on. With the connector named, "Try again" starts its
 * sign-in once more and the integration's page is one click away; without it,
 * the integrations page is where connecting starts.
 */
const RetryActions = ({ slug }: { slug: string | undefined }) => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const goToTools = () =>
    detached(
      navigate({ to: MCP_TOOLS_PATH, search: slug ? { slug } : {} }),
      "mcp-oauth-outcome.navigate",
    );
  const notifyFailed = (error: unknown) => {
    notifyUserError(error, t("knowledge.mcp.errorTitle"), {
      description: userErrorFromThrown(
        error,
        t("knowledge.mcp.errorDescription"),
      ),
    });
  };
  const openOAuthWindow = useMcpOAuthWindow((outcome) => {
    if (outcome.status === "connected") {
      goToTools();
    }
  });
  // Built outside useMutation so the connection start's result types the
  // mutation instead of being inferred back from useMutation's own generics.
  const restartFn = resourceMutation({
    mutation: "connectMcpServer",
    queryClient,
    scope: { type: "organization" },
    mutationFn: async (connectorSlug: string) =>
      await mcpConnectorConnection.start(connectorSlug),
  });
  const restart = useMutation({
    mutationFn: restartFn,
    onSuccess: (data) => {
      // A connector that no longer signs in through OAuth is set up on its
      // own page.
      if (
        data.type !== "oauth2" ||
        openOAuthWindow(data.authorizeUrl) === "invalid"
      ) {
        goToTools();
      }
    },
    onError: notifyFailed,
  });

  if (slug === undefined) {
    return (
      <Link className={cn(buttonVariants())} to={MCP_TOOLS_PATH}>
        {t("common.tryAgain")}
      </Link>
    );
  }
  return (
    <>
      <Button
        loading={restart.isPending}
        onClick={() => restart.mutate(slug)}
        type="button"
      >
        {t("common.tryAgain")}
      </Button>
      <Link
        className={cn(buttonVariants({ variant: "outline" }))}
        search={{ slug }}
        to={MCP_TOOLS_PATH}
      >
        {t("knowledge.mcp.openTools")}
      </Link>
    </>
  );
};

/**
 * Where an integration's sign-in ends. A popup tells its opener and closes;
 * a tab that stays open shows the outcome, and after a failure, the way on.
 */
export const McpOAuthOutcomeScreen = ({
  outcome,
  slug,
  closeTab,
}: {
  outcome: McpOAuthOutcome;
  slug: string | undefined;
  closeTab?: OutcomeCloseTab;
}) => {
  const t = useTranslations();
  const connected = outcome.status === "connected";
  const title = connected
    ? t("knowledge.mcp.callbackConnectedTitle")
    : t("knowledge.mcp.callbackFailedTitle");
  return (
    <OutcomeScreen
      actions={connected ? undefined : <RetryActions slug={slug} />}
      {...(closeTab === undefined ? {} : { closeTab })}
      description={
        connected
          ? t("knowledge.mcp.callbackConnectedDescription")
          : t("knowledge.mcp.callbackFailedDescription")
      }
      documentTitle={pageTitleLiteral(title)}
      title={title}
      tone={connected ? "success" : "error"}
    />
  );
};
