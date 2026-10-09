import { Result } from "better-result";
import { expect, test } from "bun:test";

import { getMcpResourceUrl } from "@/api/mcp/constants";
import { McpAuthenticationError } from "@/api/mcp/errors";

import { authenticateLegalResolveToken } from "./authentication";

test("dispatches service tokens after one law-audience verification", async () => {
  let verifications = 0;
  let clientReads = 0;
  const result = await authenticateLegalResolveToken("synthetic-token", {
    verifyToken: async (_token, options) => {
      verifications += 1;
      expect(options.verifyOptions?.audience).toBe(getMcpResourceUrl("law"));
      return {
        stella_principal: "service",
        sub: "client",
        client_id: "client",
      };
    },
    resolveService: async () => {
      clientReads += 1;
      return {
        type: "service",
        clientId: "client",
        organizationId: "organization",
        scopes: ["stella:law_read"],
        requestsPerMinute: 3,
        dailyBudget: 5,
      };
    },
  });
  expect(Result.isOk(result)).toBe(true);
  expect(verifications).toBe(1);
  expect(clientReads).toBe(1);
});

test("does not read client authority after a verification refusal", async () => {
  let clientReads = 0;
  const result = await authenticateLegalResolveToken("synthetic-token", {
    verifyToken: async () => {
      throw new McpAuthenticationError({
        message: "Synthetic verification refusal",
      });
    },
    resolveService: async () => {
      clientReads += 1;
      return null;
    },
  });
  expect(Result.isError(result)).toBe(true);
  expect(clientReads).toBe(0);
});

test("does not resolve user tokens as services", async () => {
  let clientReads = 0;
  const result = await authenticateLegalResolveToken("synthetic-token", {
    verifyToken: async () => ({
      sub: "synthetic-user",
      org_id: "synthetic-org",
      scope: "stella:law_read",
    }),
    resolveService: async () => {
      clientReads += 1;
      return null;
    },
  });
  expect(Result.isOk(result)).toBe(true);
  expect(clientReads).toBe(0);
});
