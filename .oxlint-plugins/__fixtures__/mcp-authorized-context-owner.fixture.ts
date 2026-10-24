// oxlint-disable-next-line mcp-authorized-context-owner/mcp-authorized-context-owner -- test helpers stay in test modules
import { authorizedMcpContextForTest } from "@/api/tests/helpers/authorized-mcp-context";

// expect-clean: mcp-authorized-context-owner/mcp-authorized-context-owner
import { authorizeMcpToolContext } from "@/api/mcp/write-tool-authority";

// oxlint-disable-next-line mcp-authorized-context-owner/mcp-authorized-context-owner -- brand declarations stay in their owner
const authorizedMcpRequestContextBrand = Symbol("forged");

void authorizedMcpContextForTest;
void authorizedMcpRequestContextBrand;
void authorizeMcpToolContext;
