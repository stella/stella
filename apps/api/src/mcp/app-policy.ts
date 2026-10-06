import { MCP_APPS } from "./apps/manifest";
import type { McpMode } from "./constants";
import { isMcpDescriptorFeatureEnabled } from "./feature-access";
import type { McpFeatureAccessContext } from "./feature-access";
import { getStaticMcpToolDefinition } from "./static-tool-definitions";
import { isMcpToolFeatureEnabled } from "./tool-feature";

type IsMcpAppAvailableArgs = {
  uri: string;
  mode: McpMode;
  context: McpFeatureAccessContext | undefined;
};

export const isMcpAppAvailable = ({
  uri,
  mode,
  context,
}: IsMcpAppAvailableArgs): boolean => {
  const app = MCP_APPS.find((entry) => entry.uri === uri);
  if (app === undefined) {
    return false;
  }
  return app.linkedTools.every((name) => {
    const tool = getStaticMcpToolDefinition(name, mode);
    return (
      tool !== undefined &&
      isMcpToolFeatureEnabled(tool.feature) &&
      isMcpDescriptorFeatureEnabled({
        context,
        kind: "tools",
        id: name,
        featureId: tool.featureId,
      })
    );
  });
};
