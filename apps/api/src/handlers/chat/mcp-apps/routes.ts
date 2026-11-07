import { routes } from "@/api/http/route";
import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

import callChatMcpAppTool from "./call-tool";
import readChatMcpAppBundle from "./read-bundle";

/**
 * Every app chat shows presents public-law reads (`catalog.test.ts` holds
 * them to it), so the apps are served only where the public corpus is.
 */
export const chatMcpAppsRoute = routes(
  {
    "/mcp-apps/:app": { GET: readChatMcpAppBundle },
    "/threads/:threadId/mcp-apps/:toolCallId/call": {
      POST: callChatMcpAppTool,
    },
  },
  {
    prefix: "/chat",
    middleware: [deploymentFeatureGate("FEATURE_PUBLIC_LAW")],
  },
);
