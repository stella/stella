import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { mcpConnectorConnection } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import { mcpConnectionsOptions } from "@/lib/knowledge/queries";
import {
  subscribeToMcpConnectionRefresh,
  useMcpOAuthWindow,
} from "@/lib/mcp-oauth-channel";

type McpReconnectButtonProps = {
  slug: string;
  authType: "none" | "bearer" | "oauth2";
  oauthRefresh?: "self" | "owner";
};

export const useMcpConnectionOAuthRefresh = (enabled = true) => {
  const queryClient = useQueryClient();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const onConnected = useLatestCallback(() => {
    detached(
      queryClient.invalidateQueries({
        queryKey: mcpConnectionsOptions(activeOrganizationId, userId).queryKey,
      }),
      "mcp-reconnect-button.invalidate",
    );
  });
  useExternalSyncEffect(() => {
    if (!enabled) {
      return undefined;
    }
    return subscribeToMcpConnectionRefresh(onConnected);
  }, [enabled, onConnected]);
};

export const McpReconnectButton = ({
  slug,
  authType,
  oauthRefresh = "self",
}: McpReconnectButtonProps) => {
  const t = useTranslations();
  useMcpConnectionOAuthRefresh(
    oauthRefresh === "self" && authType === "oauth2",
  );
  const handleError = (error: unknown) => {
    notifyUserError(error, t("knowledge.mcp.errorTitle"), {
      description: userErrorFromThrown(
        error,
        t("knowledge.mcp.errorDescription"),
      ),
    });
  };
  const openOAuthWindow = useMcpOAuthWindow((outcome) => {
    if (outcome.status === "error") {
      handleError(undefined);
    }
  });
  const reconnect = useMutation({
    mutationFn: async () => await mcpConnectorConnection.start(slug),
    onSuccess: (data) => {
      switch (data.type) {
        case "oauth2":
          if (openOAuthWindow(data.authorizeUrl) === "invalid") {
            handleError(undefined);
          }
          return;
        case "bearer":
        case "none":
          handleError(undefined);
          return;
        default:
          panic(data satisfies never);
      }
    },
    onError: handleError,
  });

  switch (authType) {
    case "none":
      return null;
    case "bearer":
      return (
        <Button
          className="min-h-11"
          render={<Link search={{ slug }} to="/knowledge/tools" />}
          size="xs"
          variant="outline"
        >
          {t("knowledge.mcp.reconnect")}
        </Button>
      );
    case "oauth2":
      return (
        <Button
          className="min-h-11"
          disabled={reconnect.isPending}
          onClick={() => reconnect.mutate()}
          size="xs"
          type="button"
          variant="outline"
        >
          {t("knowledge.mcp.reconnect")}
        </Button>
      );
    default:
      return panic(authType satisfies never);
  }
};
