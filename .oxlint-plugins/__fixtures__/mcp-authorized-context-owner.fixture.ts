import { createAuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";

const authorizedMcpRequestContextBrand = Symbol("forged");

void createAuthorizedMcpRequestContext;
void authorizedMcpRequestContextBrand;
