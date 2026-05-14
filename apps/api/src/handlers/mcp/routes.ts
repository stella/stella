import { createMcpRoute } from "@/api/handlers/mcp/routes-core";
import { handleMcpHttpRequest } from "@/api/mcp/server";

export const mcpRoute = createMcpRoute({ handleMcpHttpRequest });
