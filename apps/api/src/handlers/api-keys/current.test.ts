import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { createCurrentMachineApiKeyHandler } from "@/api/handlers/api-keys/current";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { MACHINE_API_KEY_PREFIX } from "@/api/lib/machine-api-key-config";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";
import type { resolveMachineApiKeyCredential } from "@/api/mcp/api-key-auth";
import { McpAuthenticationError } from "@/api/mcp/errors";

type ResolveCredential = typeof resolveMachineApiKeyCredential;
type ResolveCredentialInput = Parameters<ResolveCredential>[0];

const expiresAt = new Date("2026-10-08T12:00:00.000Z");
const presentedCredential = `${MACHINE_API_KEY_PREFIX}secret-credential-value`;

const createApp = (resolveCredential: ResolveCredential) =>
  new Elysia().get(
    "/current",
    createCurrentMachineApiKeyHandler(resolveCredential).handler,
  );

const requestCurrent = (authorization?: string) =>
  new Request("http://localhost/current", {
    headers: authorization ? { authorization } : undefined,
  });

describe("GET /current", () => {
  test("returns only this credential's expiry with private caching", async () => {
    const resolvedInputs: ResolveCredentialInput[] = [];
    const resolveCredential: ResolveCredential = async (credential) => {
      resolvedInputs.push(credential);
      return {
        expiresAt,
        session: {
          userId: "user-secret",
          organizationId: "organization-secret",
          scopes: ["stella:read"],
          credential: {
            type: "machine_api_key",
            id: "key-secret",
            name: "Private key name",
            permissions: { workspace: ["read"] },
          },
        },
      };
    };
    const response = await createApp(resolveCredential).handle(
      requestCurrent(`Bearer ${presentedCredential}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get(CACHE_CONTROL_HEADER)).toBe(
      PRIVATE_CACHE_CONTROL,
    );
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ expiresAt: expiresAt.toISOString() });
    expect(resolvedInputs).toEqual([presentedCredential]);
    expect(body).not.toContain("user-secret");
    expect(body).not.toContain("organization-secret");
    expect(body).not.toContain("key-secret");
    expect(body).not.toContain("Private key name");
    expect(body).not.toContain("secret-credential-value");
  });

  test("rejects missing, wrong-prefix, and overlong credentials before resolution", async () => {
    let resolverCalls = 0;
    const resolveCredential: ResolveCredential = async () => {
      resolverCalls += 1;
      return {
        expiresAt,
        session: { userId: "user-1", organizationId: "org-1", scopes: [] },
      };
    };
    const app = createApp(resolveCredential);
    const invalidAuthorizations = [
      undefined,
      "Bearer stella_wrong_secret",
      `Bearer ${MACHINE_API_KEY_PREFIX}${"a".repeat(256)}`,
    ];

    for (const authorization of invalidAuthorizations) {
      const response = await app.handle(requestCurrent(authorization));
      expect(response.status).toBe(401);
      expect(response.headers.get(CACHE_CONTROL_HEADER)).toBe(
        PRIVATE_CACHE_CONTROL,
      );
    }

    expect(resolverCalls).toBe(0);
  });

  test("maps authentication failures to 401 and unexpected tagged failures to 503", async () => {
    const appFor = (failure: Error) =>
      createApp(async () => {
        throw failure;
      });

    const unauthorized = await appFor(
      new McpAuthenticationError({ message: "Invalid or expired API key" }),
    ).handle(requestCurrent(`Bearer ${presentedCredential}`));
    const unavailable = await appFor(
      new HandlerError({
        status: 500,
        message: "credential store unavailable",
      }),
    ).handle(requestCurrent(`Bearer ${presentedCredential}`));

    expect(unauthorized.status).toBe(401);
    expect(unavailable.status).toBe(503);
  });
});
