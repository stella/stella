import { routes } from "@/api/http/route";

import callChatMcpAppTool from "./call-tool";
import readChatMcpAppBundle from "./read-bundle";

/**
 * Every app chat shows presents public-law reads (`mcp-app-catalog.test.ts` holds
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
    deployment: { type: "flag", flag: "FEATURE_PUBLIC_LAW" },
  },
);
