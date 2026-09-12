import { Result } from "better-result";
import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { SignJWT } from "jose";

import { replayBetterAuthSignIns } from "./better-auth-sign-in-replay";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("Better Auth sign-in replay transaction boundary (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("Better Auth sign-in replay transaction boundary (postgres)", () => {
    test("preserves every auth row across successful, repeated, and rejected replays", async () => {
      const client = new SQL({ max: 1, url: databaseUrl });
      const schema = `better_auth_replay_${Bun.randomUUIDv7().replaceAll("-", "_")}`;
      const quotedSchema = `"${schema}"`;
      const clientId = "replay-client-id";
      const tenantId = "replay-tenant-id";
      const oauthBaseUrl = "https://replay.example.test";
      const userId = `replay-user-${Bun.randomUUIDv7()}`;
      const accountId = `replay-account-a-${Bun.randomUUIDv7()}`;
      const malformedAccountId = `replay-account-z-${Bun.randomUUIDv7()}`;
      const sessionId = `replay-session-${Bun.randomUUIDv7()}`;
      const verificationId = `replay-verification-${Bun.randomUUIDv7()}`;
      const oldCreatedAt = new Date("2024-01-02T03:04:05.000Z");
      const oldUpdatedAt = new Date("2024-01-03T04:05:06.000Z");
      const oldExpiresAt = new Date("2099-01-04T05:06:07.000Z");
      const oldAccessTokenExpiresAt = new Date("2024-02-02T03:04:05.000Z");
      const oldRefreshTokenExpiresAt = new Date("2024-03-02T03:04:05.000Z");

      const idToken = await new SignJWT({
        email: "replay@example.test",
        name: "Replay User",
        oid: "replay-object-id",
        preferred_username: "replay@example.test",
        tid: tenantId,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
        .setAudience(clientId)
        .setSubject("replay-subject")
        .setIssuedAt(1_704_164_645)
        .setExpirationTime(4_102_444_800)
        .sign(new TextEncoder().encode("replay-signing-secret"));
      const secondIdToken = await new SignJWT({
        email: "replay@example.test",
        name: "Replay User",
        oid: "malformed-object-id",
        preferred_username: "replay@example.test",
        tid: tenantId,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
        .setAudience(clientId)
        .setSubject("second-replay-subject")
        .setIssuedAt(1_704_164_645)
        .setExpirationTime(4_102_444_800)
        .sign(new TextEncoder().encode("replay-signing-secret"));

      const snapshot = async () => {
        const [row] = await client`
          SELECT jsonb_build_object(
            'user', COALESCE((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.id) FROM "user" u), '[]'::jsonb),
            'account', COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM account a), '[]'::jsonb),
            'session', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM session s), '[]'::jsonb),
            'verification', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM verification v), '[]'::jsonb)
          ) AS snapshot
        `;
        if (!row || typeof row.snapshot !== "object" || row.snapshot === null) {
          throw new Error("expected auth row snapshot");
        }
        return row.snapshot;
      };

      try {
        await client.unsafe(`CREATE SCHEMA ${quotedSchema}`);
        for (const table of ["user", "account", "session", "verification"]) {
          await client.unsafe(
            `CREATE TABLE ${quotedSchema}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
          );
        }
        await client.unsafe(`SET search_path TO ${quotedSchema}`);
        await client`
          INSERT INTO "user" (
            id, name, email, email_verified, image, timezone_id,
            preferred_name, word_edit_shortcut, user_shortcuts, guide_progress,
            detected_country, two_factor_enabled, deleted_at, created_at, updated_at
          ) VALUES (
            ${userId}, 'Replay User', 'replay@example.test', true, 'old-image', 'Europe/Prague',
            'Old Name', 'Mod+K', '{"old":true}', '{"tour":"done"}',
            'CZ', true, NULL, ${oldCreatedAt}, ${oldUpdatedAt}
          )
        `;
        await client`
          INSERT INTO account (
            id, issuer, account_id, provider_id, user_id, access_token,
            refresh_token, id_token, access_token_expires_at, refresh_token_expires_at,
            scope, password, created_at, updated_at
          ) VALUES (
            ${accountId}, 'old-issuer', 'replay-object-id', 'microsoft', ${userId},
            'old-access-token', 'old-refresh-token', ${idToken}, ${oldAccessTokenExpiresAt},
            ${oldRefreshTokenExpiresAt}, 'old-scope', 'old-password', ${oldCreatedAt}, ${oldUpdatedAt}
          )
        `;
        await client`
          INSERT INTO account (
            id, issuer, account_id, provider_id, user_id, access_token,
            refresh_token, id_token, access_token_expires_at, refresh_token_expires_at,
            scope, password, created_at, updated_at
          ) VALUES (
            ${malformedAccountId}, 'old-issuer', 'malformed-object-id', 'microsoft', ${userId},
            'malformed-access-token', 'malformed-refresh-token', ${secondIdToken}, ${oldAccessTokenExpiresAt},
            ${oldRefreshTokenExpiresAt}, 'malformed-scope', 'malformed-password', ${oldCreatedAt}, ${oldUpdatedAt}
          )
        `;
        await client`
          INSERT INTO session (
            id, expires_at, token, created_at, updated_at, ip_address,
            user_agent, user_id, active_organization_id
          ) VALUES (
            ${sessionId}, ${oldExpiresAt}, 'old-session-token', ${oldCreatedAt}, ${oldUpdatedAt},
            '192.0.2.1', 'old-user-agent', ${userId}, 'old-organization'
          )
        `;
        await client`
          INSERT INTO verification (
            id, identifier, value, expires_at, created_at, updated_at
          ) VALUES (
            ${verificationId}, 'old-identifier', 'old-verification-value',
            ${oldExpiresAt}, ${oldCreatedAt}, ${oldUpdatedAt}
          )
        `;

        const before = await snapshot();
        const first = await replayBetterAuthSignIns({
          client,
          clientId,
          oauthBaseUrl,
          sessionSample: 1,
          tenantId,
        });
        expect(first).toMatchObject({
          status: "ok",
          value: {
            accounts: 2,
            signIns: { resolved: 2, created: 0, mismatched: 0, rejected: 0 },
            sessions: { resolved: 1, unresolved: 0 },
          },
        });
        expect(await snapshot()).toEqual(before);

        const second = await replayBetterAuthSignIns({
          client,
          clientId,
          oauthBaseUrl,
          sessionSample: 1,
          tenantId,
        });
        expect(second.isOk()).toBe(true);
        expect(await snapshot()).toEqual(before);

        await client`UPDATE account SET id_token = 'malformed-jwt' WHERE id = ${malformedAccountId}`;
        const malformedBefore = await snapshot();
        const rejected = await replayBetterAuthSignIns({
          client,
          clientId,
          oauthBaseUrl,
          sessionSample: 1,
          tenantId,
        });
        expect(Result.isError(rejected)).toBe(true);
        expect(await snapshot()).toEqual(malformedBefore);
      } finally {
        await client.unsafe(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
        await client.end();
      }
    });
  });
}
