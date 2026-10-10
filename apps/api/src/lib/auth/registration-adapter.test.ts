import { createCimdClientDiscovery } from "@better-auth/cimd";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import { envApiServerSchema } from "@/api/env-schema";
import {
  admitOpenClient,
  REGISTRATION_RETENTION_SCHEMA_PLUGIN,
  authorizationClientId,
  requireAuthRetention,
  withAuthRetention,
} from "@/api/lib/auth/registration-adapter";

describe("auth persistence retention", () => {
  test.each(["open-client", "managed"] as const)(
    "applies the declared lifecycle for %s registration",
    async (origin) => {
      const database: Record<string, Record<string, unknown>[]> = {
        user: [],
        session: [],
        account: [],
        verification: [],
        oauthClient: [],
        oauthClientResource: [],
        oauthResource: [],
      };
      const raw = memoryAdapter(database);
      let admissions = 0;
      const auth = betterAuth({
        baseURL: "http://localhost:3001",
        secret: "test-secret-that-is-long-enough-for-better-auth",
        emailAndPassword: { enabled: true },
        database: (options) =>
          withAuthRetention({
            adapter: raw(options),
            admitClient: async () => {
              admissions += 1;
              await admitOpenClient({
                limit: v.parse(
                  envApiServerSchema.OPEN_CLIENT_REGISTRATION_DAILY_LIMIT,
                  "5",
                ),
                now: new Date("2026-01-01T12:00:00Z"),
                execute: async () => ({ length: 0 }),
              });
            },
          }),
        plugins: [
          REGISTRATION_RETENTION_SCHEMA_PLUGIN,
          oauthProvider({
            loginPage: "/sign-in",
            consentPage: "/consent",
            disableJwtPlugin: true,
            resourceSeedMode: "none",
            allowDynamicClientRegistration: true,
            allowUnauthenticatedClientRegistration: true,
          }),
        ],
      });
      const headers = new Headers({ "content-type": "application/json" });
      if (origin === "managed") {
        const signup = await auth.api.signUpEmail({
          body: {
            name: "Account",
            email: "account@example.test",
            password: "A secure password 123!",
          },
          asResponse: true,
        });
        expect(signup.status).toBe(200);
        const cookie = signup.headers.get("set-cookie")?.split(";").at(0);
        if (!cookie) {
          panic("Session cookie is required");
        }
        headers.set("cookie", cookie);
      }
      const endpoint =
        origin === "managed" ? "/oauth2/create-client" : "/oauth2/register";
      const response = await auth.handler(
        new Request(`http://localhost:3001/api/auth${endpoint}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            client_name: "Client",
            redirect_uris: ["https://client.example.test/callback"],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
          }),
        }),
      );
      expect(response.status).toBe(origin === "managed" ? 201 : 503);
      expect(admissions).toBe(origin === "managed" ? 0 : 1);
      expect(database["oauthClient"]).toHaveLength(
        origin === "managed" ? 1 : 0,
      );
      if (origin === "managed") {
        expect(database["oauthClient"]?.at(0)).toMatchObject({
          registrationOrigin: "managed",
        });
      }
      const { adapter } = await auth.$context;
      expect(
        await rejectionOf(
          adapter.create({
            model: "oauthClient",
            data: { clientId: "unclassified-client" },
          }),
        ),
      ).toMatchObject({
        statusCode: 500,
        body: { message: "Client registration requires a declared origin." },
      });
    },
  );

  test.each(["direct", "transaction"] as const)(
    "tracks only existing clients during %s reads",
    async (mode) => {
      const clientId = "registered-client";
      const database = {
        user: [],
        session: [],
        account: [],
        verification: [],
        oauthClient: [{ id: "client-row", clientId }],
        oauthClientResource: [],
        oauthResource: [],
      };
      const raw = memoryAdapter(database);
      const touched: string[] = [];
      const auth = betterAuth({
        baseURL: "http://localhost:3001",
        secret: "test-secret-that-is-long-enough-for-better-auth",
        database: (options) =>
          withAuthRetention({
            adapter: raw(options),
            admitClient: async () => {},
            touchClient: async (id) => {
              touched.push(id);
            },
          }),
        plugins: [
          REGISTRATION_RETENTION_SCHEMA_PLUGIN,
          oauthProvider({
            loginPage: "/sign-in",
            consentPage: "/consent",
            disableJwtPlugin: true,
            resourceSeedMode: "none",
          }),
        ],
      });
      const { adapter } = await auth.$context;
      for (const id of ["missing-client", clientId]) {
        const query = {
          model: "oauthClient",
          where: [{ field: "clientId", value: id }],
        };
        const row =
          mode === "direct"
            ? await adapter.findOne(query)
            : await adapter.transaction(async (tx) => await tx.findOne(query));
        expect(row).toEqual(
          id === clientId ? { id: "client-row", clientId } : null,
        );
        expect(touched).toEqual(id === clientId ? [clientId] : []);
      }
    },
  );

  test.each(["direct", "transaction"] as const)(
    "requires declared models for %s creation",
    async (mode) => {
      const database = { user: [], session: [], account: [], verification: [] };
      const raw = memoryAdapter(database);
      const auth = betterAuth({
        baseURL: "http://localhost:3001",
        secret: "test-secret-that-is-long-enough-for-better-auth",
        database: (options) =>
          withAuthRetention({
            adapter: raw(options),
            admitClient: async () => {},
          }),
      });
      const { adapter } = await auth.$context;
      const data = { model: "undeclaredModel", data: { name: "Account" } };
      const created =
        mode === "direct"
          ? adapter.create(data)
          : adapter.transaction(async (tx) => await tx.create(data));
      expect(await rejectionOf(created)).toMatchObject({
        statusCode: 500,
        body: { message: "Database model requires a retention declaration." },
      });
      expect(database.user).toHaveLength(0);
    },
  );

  test("requires a complete declaration for every mapped table", () => {
    for (const declaration of [
      undefined,
      { boundedBy: " " },
      { ttlColumn: "expires_at", sweeper: " " },
    ]) {
      expect(() =>
        requireAuthRetention({
          model: "user",
          tables: { user: "user" },
          lookup: () => declaration,
        }),
      ).toThrow("Database model requires a retention declaration.");
    }
    expect(requireAuthRetention({ model: "user" })).toBe("user");
  });

  test.each([false, true])(
    "applies client admission to metadata registration: %s",
    async (admitted) => {
      const clientId = "https://client.example.test/metadata.json";
      const database: Record<string, Record<string, unknown>[]> = {
        user: [],
        session: [],
        account: [],
        verification: [],
        oauthClient: [],
        oauthClientResource: [],
        oauthResource: [],
      };
      const raw = memoryAdapter(database);
      let fetched = 0;
      let admissions = 0;
      const auth = betterAuth({
        baseURL: "http://localhost:3001",
        secret: "test-secret-that-is-long-enough-for-better-auth",
        database: (options) =>
          withAuthRetention({
            adapter: raw(options),
            admitClient: async () => {
              admissions += 1;
              await admitOpenClient({
                limit: v.parse(
                  envApiServerSchema.OPEN_CLIENT_REGISTRATION_DAILY_LIMIT,
                  "5",
                ),
                now: new Date("2026-01-01T12:00:00Z"),
                execute: async () => ({ length: admitted ? 1 : 0 }),
              });
            },
          }),
        plugins: [
          REGISTRATION_RETENTION_SCHEMA_PLUGIN,
          oauthProvider({
            loginPage: "/sign-in",
            consentPage: "/consent",
            disableJwtPlugin: true,
            resourceSeedMode: "none",
            scopes: ["read"],
            extensions: [
              {
                clientDiscovery: createCimdClientDiscovery({
                  fetchClientMetadataResource: async () => {
                    fetched += 1;
                    return Response.json({
                      client_id: clientId,
                      client_name: "Client",
                      redirect_uris: ["https://client.example.test/callback"],
                      token_endpoint_auth_method: "none",
                      grant_types: ["authorization_code"],
                      response_types: ["code"],
                    });
                  },
                }),
              },
            ],
          }),
        ],
      });
      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: "https://client.example.test/callback",
        response_type: "code",
        scope: "read",
        code_challenge: "a".repeat(43),
        code_challenge_method: "S256",
        state: "request-state",
      });
      const response = await auth.handler(
        new Request(
          `http://localhost:3001/api/auth/oauth2/authorize?${query.toString()}`,
        ),
      );
      expect(fetched).toBe(1);
      expect(admissions).toBe(1);
      expect(database["user"]).toHaveLength(0);
      expect(database["session"]).toHaveLength(0);
      expect(database["oauthClient"]).toHaveLength(admitted ? 1 : 0);
      if (admitted) {
        expect(response.status).toBe(302);
        expect(database["oauthClient"]?.at(0)).toMatchObject({
          registrationOrigin: "open-client",
        });
      } else {
        expect(response.status).toBe(503);
        expect(database["oauthClient"]?.at(0)).toBeUndefined();
      }
    },
  );

  test("extracts authorization clients only from authorization-code records", () => {
    expect(
      authorizationClientId({
        value: JSON.stringify({
          type: "authorization_code",
          query: { client_id: "client" },
        }),
      }),
    ).toBe("client");
    expect(
      authorizationClientId({
        value: JSON.stringify({
          type: "other",
          query: { client_id: "client" },
        }),
      }),
    ).toBeUndefined();
    expect(authorizationClientId({ value: "opaque" })).toBeUndefined();
    expect(() =>
      authorizationClientId({
        value: JSON.stringify({ type: "authorization_code", query: {} }),
      }),
    ).toThrow("Authorization client is required.");
  });
});
