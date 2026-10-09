import { Result, panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { decodeJwt } from "jose";
import * as v from "valibot";

import { sha256Base64Url } from "@stll/sha256/bun";

import { oauthClient, organization } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { auditLogs } from "@/api/db/schema";
import { authenticateLegalResolveToken } from "@/api/handlers/legal-resolve/authentication";
import { meRoute } from "@/api/handlers/me/routes";
import { AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log.constants";
import { getAuth } from "@/api/lib/auth";
import { getAuthEndpointUrl } from "@/api/lib/auth/auth-paths";
import { extractMcpSession } from "@/api/mcp/auth";
import { getMcpResourceUrl } from "@/api/mcp/constants";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";

import {
  readServiceOAuthClient,
  recordServiceResolveAudit,
  resolveServiceOAuthToken,
} from "./service-client";
import {
  createServiceOAuthClient,
  changeServiceOAuthClient,
} from "./service-client-operator";

beforeAll(initAgentAuthTestDb);
afterAll(releaseAgentAuthTestDb);

const tokenSchema = v.looseObject({
  access_token: v.string(),
  scope: v.string(),
});
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
    organizationId,
    name: "Synthetic service client",
    requestsPerMinute: 2,
    dailyBudget: 3,
    operatorUid: 12_345,
  });
  return { ...client, organizationId };
};

describe("confidential service OAuth lifecycle", () => {
  test("issues organization-bound law tokens with no user and persists only the secret hash", async () => {
    const client = await fixture();
    const response = await issue(client);
    expect(response.status).toBe(200);
    const token = v.parse(tokenSchema, await response.json());
    const payload = decodeJwt(token.access_token);
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

  test.each([
    "stella:read",
    "stella:law_read stella:documents_write",
    "openid",
    "offline_access",
  ])("enforces the machine scope ceiling for %s", async (scope) => {
    const response = await issue(await fixture(), scope);
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
    expect((await issue(client)).status).toBe(401);
    expect(
      await resolveServiceOAuthToken(decodeJwt(old.access_token)),
    ).toBeNull();
    const next = await issue({ clientId: client.clientId, clientSecret });
    expect(next.status).toBe(200);
    const payload = decodeJwt(
      v.parse(tokenSchema, await next.json()).access_token,
    );
    expect(payload["stella_client_version"]).toBe(2);
    expect(await resolveServiceOAuthToken(payload)).not.toBeNull();
  });

  test("disable refuses the next exchange and every outstanding token", async () => {
    const client = await fixture();
    const tokens = await Promise.all([issue(client), issue(client)]);
    const payloads = await Promise.all(
      tokens.map(async (response) =>
        decodeJwt(v.parse(tokenSchema, await response.json()).access_token),
      ),
    );
    await changeServiceOAuthClient({
      clientId: client.clientId,
      operation: "disable",
      operatorUid: 12_345,
    });
    expect((await issue(client)).status).toBe(401);
    for (const payload of payloads) {
      expect(await resolveServiceOAuthToken(payload)).toBeNull();
    }
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
          expect(options.verifyOptions?.audience).toBe(
            getMcpResourceUrl("law"),
          );
          return payload;
        },
      },
    );
    expect(Result.isOk(authenticated)).toBe(true);
    expect(verifications).toBe(1);
  });

  test("records a resolve call under the service organization without query or credentials", async () => {
    const client = await fixture();
    const token = v.parse(tokenSchema, await (await issue(client)).json());
    const principal =
      (await resolveServiceOAuthToken(decodeJwt(token.access_token))) ??
      panic("Synthetic service principal required");
    await recordServiceResolveAudit({
      principal,
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
