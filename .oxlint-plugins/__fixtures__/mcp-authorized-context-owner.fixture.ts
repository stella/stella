// oxlint-disable-next-line mcp-authorized-context-owner/mcp-authorized-context-owner -- authority construction stays in its owner
import { authorizedMcpContextForTest } from "@/api/mcp/write-tool-authority";

// oxlint-disable-next-line mcp-authorized-context-owner/mcp-authorized-context-owner -- brand declarations stay in their owner
const authorizedMcpRequestContextBrand = Symbol("forged");

// expect-clean: mcp-authorized-context-owner/mcp-authorized-context-owner
import { authorizeMcpToolContext } from "@/api/mcp/write-tool-authority";

void authorizedMcpContextForTest;
void authorizedMcpRequestContextBrand;
void authorizeMcpToolContext;
