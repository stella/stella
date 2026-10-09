import { describe, expect, test } from "bun:test";
import type { JWTPayload } from "jose";

import { servicePrincipalFromClaims } from "./service-client-policy";
import type { ServiceClientBinding } from "./service-client-policy";

const binding = {
  credentialVersion: 1,
  clientId: "synthetic-service-client",
  organizationId: "synthetic-service-org",
  disabled: false,
  type: "service",
  userId: null,
  clientCredentialsScopes: ["stella:law_read"],
  requestsPerMinute: 10,
  dailyBudget: 100,
} satisfies ServiceClientBinding;
const claims = {
  stella_client_version: 1,
  sub: binding.clientId,
  client_id: binding.clientId,
  org_id: binding.organizationId,
  stella_principal: "service",
  scope: "stella:law_read",
} satisfies JWTPayload;

describe("service OAuth principal boundary", () => {
  test("carries only the bound organization and client authority", () => {
    expect(servicePrincipalFromClaims(claims, binding)).toEqual({
      type: "service",
      clientId: binding.clientId,
      organizationId: binding.organizationId,
      scopes: ["stella:law_read"],
      requestsPerMinute: 10,
      dailyBudget: 100,
    });
    expect(servicePrincipalFromClaims(claims, binding)).not.toHaveProperty(
      "userId",
    );
  });
  test.each([
    { stella_client_version: 0 },
    { stella_client_version: undefined },
    { stella_principal: "user" },
    { sub: "some-user" },
    { client_id: "other-client" },
    { org_id: "other-org" },
    { scope: "" },
    { scope: "stella:read" },
    { scope: "stella:law_read stella:documents_write" },
  ])("refuses claims outside the live client binding: %j", (change) => {
    expect(
      servicePrincipalFromClaims({ ...claims, ...change }, binding),
    ).toBeNull();
  });
  test.each([
    { credentialVersion: 2 },
    { disabled: true },
    { type: "web" },
    { userId: "some-user" },
    { clientCredentialsScopes: [] },
  ])("refuses changed client authority: %j", (change) => {
    expect(
      servicePrincipalFromClaims(claims, { ...binding, ...change }),
    ).toBeNull();
  });
});
