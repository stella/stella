import { describe, expect, test } from "bun:test";
import type { JWTPayload } from "jose";

import type { ServiceClientBinding } from "@/api/lib/db/service-client-contract";

import { servicePrincipalFromClaims } from "./service-client-policy";

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
  test("refuses a token from an earlier credential version", () => {
    expect(
      servicePrincipalFromClaims(
        { ...claims, stella_client_version: 0 },
        binding,
      ),
    ).toBeNull();
  });
  test("refuses a disabled client", () => {
    expect(
      servicePrincipalFromClaims(claims, { ...binding, disabled: true }),
    ).toBeNull();
  });
});
