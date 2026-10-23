import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import * as v from "valibot";

import { sha256Base64Url } from "@stll/sha256/bun";

import {
  oauthClient,
  oauthClientResource,
  organization,
} from "@/api/db/auth-schema";
import {
  changeServiceOAuthClient,
  createServiceOAuthClient,
  recordLegalResolveAudit,
  rootDb,
} from "@/api/db/root";
import { auditLogs, serviceOAuthClients } from "@/api/db/schema";
import { authenticateLegalResolveToken } from "@/api/handlers/legal-resolve/authentication";
import { meRoute } from "@/api/handlers/me/routes";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log.constants";
import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { SERVICE_CLIENT_TYPE } from "@/api/lib/db/service-client-contract";
import { completeOrganizationDeletion } from "@/api/lib/organization-storage-teardown";
import { extractMcpSession } from "@/api/mcp/auth";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { McpAuthenticationError } from "@/api/mcp/errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";

import {
  readServiceOAuthClient,
  resolveServiceOAuthToken,
} from "./service-client";

beforeAll(initAgentAuthTestDb);
afterAll(releaseAgentAuthTestDb);

const tokenSchema = v.looseObject({
  access_token: v.string(),
  scope: v.string(),
});
const jwksSchema = v.object({
  keys: v.array(
    v.looseObject({
      kty: v.string(),
      kid: v.exactOptional(v.string()),
      alg: v.exactOptional(v.string()),
      crv: v.exactOptional(v.string()),
      x: v.exactOptional(v.string()),
      y: v.exactOptional(v.string()),
      n: v.exactOptional(v.string()),
      e: v.exactOptional(v.string()),
    }),
  ),
});

const authenticateIssuedToken = async (token: string) => {
  const response = await getAuth().handler(
    new Request(getAuthEndpointUrl("jwks")),
  );
  const keys = createLocalJWKSet(v.parse(jwksSchema, await response.json()));
  return await authenticateLegalResolveToken(token, {
    verifyToken: async (value, { verifyOptions }) =>
      (
        await jwtVerify(
          value ?? panic("Legal resolve verified a missing bearer token"),
          keys,
          verifyOptions,
        )
      ).payload,
  });
};
let requests = 0;
const issue = async (
  client: { clientId: string; clientSecret: string },
  scope = "stella:law_read",
  resource = getMcpResourceUrl("law"),
) => {
  requests += 1;
  return await getAuth().handler(
    new Request(getAuthEndpointUrl("oauth2/token"), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": `198.51.100.${String(requests)}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: client.clientId,
        client_secret: client.clientSecret,
        scope,
        resource,
      }),
    }),
  );
};

const fixture = async () => {
  const organizationId = mintAuthProviderId<"organization">();
  await rootDb.insert(organization).values({
    id: organizationId,
    name: "Synthetic service organization",
    slug: `synthetic-${organizationId}`,
    createdAt: new Date(),
  });
  const client = await createServiceOAuthClient({
    lawResourceUrl: getMcpResourceUrl("law"),
    organizationId,
    name: "Synthetic service client",
    requestsPerMinute: 2,
    dailyBudget: 3,
    operatorUid: 12_345,
  });
  return { ...client, organizationId };
};

describe("confidential service OAuth lifecycle", () => {
  test("an unavailable organization leaves no service client", async () => {
    const name = `Synthetic unavailable-${Bun.randomUUIDv7()}`;
    const result = await Result.tryPromise(
      async () =>
        await createServiceOAuthClient({
          lawResourceUrl: getMcpResourceUrl("law"),
          organizationId: mintAuthProviderId<"organization">(),
          name,
          requestsPerMinute: 2,
          dailyBudget: 3,
          operatorUid: 12_345,
        }),
    );
    expect(Result.isError(result)).toBe(true);
    expect(
      await rootDb
        .select({ clientId: oauthClient.clientId })
        .from(oauthClient)
        .where(eq(oauthClient.name, name))
        .limit(1),
    ).toHaveLength(0);
  });

  test("organization deletion removes the whole service credential", async () => {
    const { clientId, organizationId } = await fixture();
    await rootDb.transaction(
      async (tx) => await completeOrganizationDeletion({ organizationId, tx }),
    );
    for (const table of [
      oauthClient,
      oauthClientResource,
      serviceOAuthClients,
    ]) {
      expect(
        await rootDb
          .select({ clientId: table.clientId })
          .from(table)
          .where(eq(table.clientId, clientId)),
      ).toEqual([]);
    }
  });

  test.each([
    { requestsPerMinute: 0, dailyBudget: 3 },
    { requestsPerMinute: 601, dailyBudget: 3 },
    { requestsPerMinute: 2, dailyBudget: 0 },
    { requestsPerMinute: 2, dailyBudget: 100_001 },
  ])("budget constraints roll back client creation: %j", async (budgets) => {
    const { organizationId } = await fixture();
    const name = `Synthetic invalid-budget-${Bun.randomUUIDv7()}`;
    const result = await Result.tryPromise(
      async () =>
        await createServiceOAuthClient({
          lawResourceUrl: getMcpResourceUrl("law"),
          organizationId,
          name,
          ...budgets,
          operatorUid: 12_345,
        }),
    );
    expect(Result.isError(result)).toBe(true);
    expect(
      await rootDb
        .select({ clientId: oauthClient.clientId })
        .from(oauthClient)
        .where(eq(oauthClient.name, name))
        .limit(1),
    ).toHaveLength(0);
  });

  test("issues organization-bound law tokens with no user and persists only the secret hash", async () => {
    const client = await fixture();
    const response = await issue(client);
    expect(response.status).toBe(200);
    const token = v.parse(tokenSchema, await response.json());
    const payload = decodeJwt(token.access_token);
    expect(Result.isOk(await authenticateIssuedToken(token.access_token))).toBe(
      true,
    );
    expect(payload).toMatchObject({
      sub: client.clientId,
      client_id: client.clientId,
      org_id: client.organizationId,
      scope: "stella:law_read",
      stella_principal: "service",
      stella_client_version: 1,
    });
    expect(token.scope).toBe("stella:law_read");
    const stored = await readServiceOAuthClient(client.clientId);
    expect(stored?.clientSecret).toBe(sha256Base64Url(client.clientSecret));
    expect(stored?.clientSecret).not.toBe(client.clientSecret);
    const principal = await resolveServiceOAuthToken(payload);
    expect(principal?.organizationId).toBe(client.organizationId);
    expect(principal).not.toHaveProperty("userId");
    const rows = await rootDb
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.SERVICE_OAUTH_CLIENT),
          eq(auditLogs.resourceId, client.clientId),
        ),
      )
      .limit(5);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.metadata).toMatchObject({
      operation: "create",
      operatorUid: 12_345,
    });
    expect(JSON.stringify(rows)).not.toContain(client.clientSecret);
  });

  test("refuses a scope outside the law-read ceiling", async () => {
    const response = await issue(await fixture(), "stella:read");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_scope" });
  });

  test("restricts issuance to the law resource", async () => {
    const response = await issue(
      await fixture(),
      "stella:law_read",
      getMcpResourceUrl("default"),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_target" });
  });

  test("a service client without its binding refuses issuance and outstanding tokens", async () => {
    const client = await fixture();
    const issued = await issue(client);
    expect(issued.status).toBe(200);
    const token = v.parse(tokenSchema, await issued.json());
    expect(Result.isOk(await authenticateIssuedToken(token.access_token))).toBe(
      true,
    );
    const stored =
      (
        await rootDb
          .select()
          .from(oauthClient)
          .where(eq(oauthClient.clientId, client.clientId))
          .limit(1)
      ).at(0) ?? panic("The operator fixture must persist its OAuth client");
    expect(stored.type).toBe(SERVICE_CLIENT_TYPE);
    // Reinsert the operator-created credential without its cascading binding.
    await rootDb.transaction(async (tx) => {
      await tx
        .delete(oauthClient)
        .where(eq(oauthClient.clientId, client.clientId));
      await tx.insert(oauthClient).values(stored);
      await tx.insert(oauthClientResource).values({
        id: Bun.randomUUIDv7(),
        clientId: client.clientId,
        resourceId: getMcpResourceUrl("law"),
      });
    });
    expect(
      await rootDb
        .select({ clientId: oauthClient.clientId })
        .from(oauthClient)
        .where(eq(oauthClient.clientId, client.clientId)),
    ).toEqual([{ clientId: client.clientId }]);
    expect(
      await rootDb
        .select({ clientId: serviceOAuthClients.clientId })
        .from(serviceOAuthClients)
        .where(eq(serviceOAuthClients.clientId, client.clientId)),
    ).toEqual([]);
    const denied = await issue(client);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "unauthorized_client" });
    const authenticated = await authenticateIssuedToken(token.access_token);
    expect(Result.isError(authenticated)).toBe(true);
    if (Result.isError(authenticated)) {
      expect(authenticated.error).toBeInstanceOf(McpAuthenticationError);
      expect(authenticated.error.message).toBe("Service client is unavailable");
    }
  });

  test("removing a service binding removes its credential and outstanding tokens", async () => {
    const client = await fixture();
    const token = v.parse(tokenSchema, await (await issue(client)).json());
    await rootDb
      .delete(serviceOAuthClients)
      .where(eq(serviceOAuthClients.clientId, client.clientId));
    expect(
      await rootDb
        .select({ clientId: oauthClient.clientId })
        .from(oauthClient)
        .where(eq(oauthClient.clientId, client.clientId)),
    ).toEqual([]);
    const denied = await issue(client);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: "invalid_client" });
    expect(
      Result.isError(await authenticateIssuedToken(token.access_token)),
    ).toBe(true);
  });

  test("rotation changes issuance authority and invalidates outstanding tokens", async () => {
    const client = await fixture();
    const old = v.parse(tokenSchema, await (await issue(client)).json());
    const rotated = await changeServiceOAuthClient({
      clientId: client.clientId,
      operation: "rotate",
      operatorUid: 12_345,
    });
    const clientSecret =
      rotated.clientSecret ??
      panic("Rotation must return a synthetic fixture secret");
    const denied = await issue(client);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: "invalid_client" });
    expect(
      await resolveServiceOAuthToken(decodeJwt(old.access_token)),
    ).toBeNull();
    expect(
      Result.isError(await authenticateIssuedToken(old.access_token)),
    ).toBe(true);
    const next = await issue({ clientId: client.clientId, clientSecret });
    expect(next.status).toBe(200);
    const nextToken = v.parse(tokenSchema, await next.json()).access_token;
    const payload = decodeJwt(nextToken);
    expect(payload["stella_client_version"]).toBe(2);
    expect(await resolveServiceOAuthToken(payload)).not.toBeNull();
    expect(Result.isOk(await authenticateIssuedToken(nextToken))).toBe(true);
  });

  test("disable refuses the next exchange and every outstanding token", async () => {
    const client = await fixture();
    const tokens = await Promise.all([issue(client), issue(client)]);
    const accessTokens = await Promise.all(
      tokens.map(
        async (response) =>
          v.parse(tokenSchema, await response.json()).access_token,
      ),
    );
    await changeServiceOAuthClient({
      clientId: client.clientId,
      operation: "disable",
      operatorUid: 12_345,
    });
    const denied = await issue(client);
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ error: "invalid_client" });
    for (const token of accessTokens) {
      expect(await resolveServiceOAuthToken(decodeJwt(token))).toBeNull();
      expect(Result.isError(await authenticateIssuedToken(token))).toBe(true);
    }
    expect(
      Result.isError(
        await Result.tryPromise(
          async () =>
            await changeServiceOAuthClient({
              clientId: client.clientId,
              operation: "rotate",
              operatorUid: 12_345,
            }),
        ),
      ),
    ).toBe(true);
  });

  test("user-only routes and MCP sessions refuse a service token", async () => {
    const client = await fixture();
    const token = v.parse(tokenSchema, await (await issue(client)).json());
    const payload = decodeJwt(token.access_token);
    expect(Result.isError(extractMcpSession(payload))).toBe(true);
    const response = await meRoute.handle(
      new Request("http://localhost/me/oauth-connections", {
        headers: { authorization: `Bearer ${token.access_token}` },
      }),
    );
    expect(response.status).toBe(401);
    let verifications = 0;
    const authenticated = await authenticateLegalResolveToken(
      token.access_token,
      {
        verifyToken: async (_token, options) => {
          verifications += 1;
          expect(options.verifyOptions.audience).toBe(getMcpResourceUrl("law"));
          return payload;
        },
      },
    );
    expect(Result.isOk(authenticated)).toBe(true);
    expect(verifications).toBe(1);
  });

  test("records user resolve calls with their credential identity", async () => {
    const client = await fixture();
    const userId = mintAuthProviderId<"user">();
    await recordLegalResolveAudit({
      principal: {
        userId,
        organizationId: client.organizationId,
        scopes: ["stella:law_read"],
      },
      credentialKey: userId,
      route: "case",
      country: "CZE",
      outcome: "not_found",
    });
    const rows = await rootDb
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.LEGAL_RESOLVE),
          eq(auditLogs.resourceId, userId),
        ),
      )
      .limit(2);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)).toMatchObject({
      userId,
      organizationId: client.organizationId,
      performerType: "user",
      performerId: userId,
      metadata: {
        credentialKey: userId,
        route: "case",
        country: "CZE",
        outcome: "not_found",
      },
    });
  });

  test("records a resolve call under the service organization without query or credentials", async () => {
    const client = await fixture();
    const token = v.parse(tokenSchema, await (await issue(client)).json());
    const principal =
      (await resolveServiceOAuthToken(decodeJwt(token.access_token))) ??
      panic("Synthetic service principal required");
    await recordLegalResolveAudit({
      principal,
      credentialKey: principal.clientId,
      route: "law",
      country: "CZE",
      outcome: "not_found",
    });
    const rows = await rootDb
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.LEGAL_RESOLVE),
          eq(auditLogs.resourceId, client.clientId),
        ),
      )
      .limit(5);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)).toMatchObject({
      organizationId: client.organizationId,
      performerType: "service",
      performerId: client.clientId,
      metadata: {
        clientId: client.clientId,
        route: "law",
        country: "CZE",
        outcome: "not_found",
      },
    });
    expect(JSON.stringify(rows)).not.toContain(token.access_token);
    expect(JSON.stringify(rows)).not.toContain(client.clientSecret);
    await rootDb
      .delete(oauthClient)
      .where(eq(oauthClient.clientId, client.clientId));
    expect(
      await resolveServiceOAuthToken(decodeJwt(token.access_token)),
    ).toBeNull();
  });
});
