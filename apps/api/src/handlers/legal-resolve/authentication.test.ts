import { Result } from "better-result";
import { expect, test } from "bun:test";

import { getMcpResourceUrl } from "@/api/mcp/constants";
import {
  McpAuthenticationError,
  McpTokenVerificationError,
} from "@/api/mcp/errors";

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

test("verifies default-resource user tokens once against the default audience", async () => {
  let verifications = 0;
  const result = await authenticateLegalResolveToken("synthetic", {
    mode: "default",
    verifyToken: async (_token, options) => {
      verifications += 1;
      expect(options.verifyOptions?.audience).toBe(
        getMcpResourceUrl("default"),
      );
      return {
        sub: "synthetic-user",
        org_id: "synthetic-org",
        scope: "stella:law_read",
      };
    },
  });
  expect(Result.isOk(result)).toBe(true);
  expect(verifications).toBe(1);
});

test("refuses service principals outside the law resource without reading their binding", async () => {
  let reads = 0;
  const result = await authenticateLegalResolveToken("synthetic", {
    mode: "default",
    verifyToken: async () => ({ stella_principal: "service" }),
    resolveService: async () => {
      reads += 1;
      return null;
    },
  });
  expect(Result.isError(result)).toBe(true);
  expect(reads).toBe(0);
});

test("classifies a live service binding outage as infrastructure failure", async () => {
  const result = await authenticateLegalResolveToken("synthetic", {
    verifyToken: async () => ({ stella_principal: "service" }),
    resolveService: async () => {
      throw new TypeError("Synthetic binding outage");
    },
  });
  expect(Result.isError(result)).toBe(true);
  if (Result.isError(result)) {
    expect(result.error).toBeInstanceOf(McpTokenVerificationError);
  }
});
