import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { env } from "@/api/env";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { authCookiePolicy } from "@/api/lib/auth/auth-cookie-name";
import { createReviewAccountPlugin } from "@/api/lib/auth/review-account-plugin";
import { isPgConstraintError, PG_ERROR } from "@/api/lib/pg-error";
import {
  SYNTHETIC_PRINCIPAL,
  SYNTHETIC_SESSION_CONTROL_ID,
} from "@/api/lib/synthetic-principal/constants";
import {
  checkSyntheticPrincipalAccess,
  syntheticPrincipalAuthConfig,
} from "@/api/lib/synthetic-principal/policy";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const migration = readFileSync(
  new URL(
    "../../drizzle/20261019070000_monitoring_session/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);

describe.skipIf(!enabled)("monitoring session database invariants", () => {
  test("session identity and membership remain confined to the dedicated organization", async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: client } = openClient({ max: 1 });
      const schema = `monitoring_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      await client.unsafe(`CREATE SCHEMA ${schema}`);
      try {
        await client.unsafe(`SET search_path TO ${schema}, public`);
        await client.unsafe(`
          CREATE TABLE session (id text PRIMARY KEY, user_id text NOT NULL);
          CREATE TABLE organization (id text PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE, created_at timestamptz NOT NULL);
          INSERT INTO organization (id, name, slug, created_at) VALUES ('ordinary-org', 'Existing Organization', 'product-monitoring', now());
          CREATE TABLE member (id text PRIMARY KEY, user_id text NOT NULL, organization_id text NOT NULL);
        `);
        for (const statement of migration
          .replaceAll(
            "public.synthetic_session_control",
            () => `${schema}.synthetic_session_control`,
          )
          .split("--> statement-breakpoint")) {
          if (statement.trim()) {
            await client.unsafe(statement);
          }
        }
        const reservedSlug = await Result.tryPromise(
          async () =>
            client`INSERT INTO organization (id, name, slug, created_at) VALUES ('other-org', 'Other Organization', ${SYNTHETIC_PRINCIPAL.org.slug}, now())`,
        );
        expect(reservedSlug.isErr()).toBe(true);
        if (reservedSlug.isErr()) {
          expect(
            isPgConstraintError(
              reservedSlug.error,
              PG_ERROR.CHECK_VIOLATION,
              "organization_monitoring_slug_check",
            ),
          ).toBe(true);
        }
        expect(
          await client`SELECT id, slug FROM organization WHERE id = ${SYNTHETIC_PRINCIPAL.org.id}`,
        ).toEqual([
          expect.objectContaining({
            id: SYNTHETIC_PRINCIPAL.org.id,
            slug: SYNTHETIC_PRINCIPAL.org.slug,
          }),
        ]);
        await client`INSERT INTO session (id, user_id) VALUES ('synthetic-session-valid', ${SYNTHETIC_PRINCIPAL.user.id})`;
        const invalidSession = await Result.tryPromise(
          async () =>
            client`INSERT INTO session (id, user_id) VALUES ('synthetic-session-other', 'ordinary-user')`,
        );
        expect(invalidSession.isErr()).toBe(true);
        if (invalidSession.isErr()) {
          expect(
            isPgConstraintError(
              invalidSession.error,
              PG_ERROR.CHECK_VIOLATION,
              "session_monitoring_principal_check",
            ),
          ).toBe(true);
        }
        const smokeSession = await Result.tryPromise(
          async () =>
            client`INSERT INTO session (id, user_id) VALUES ('smoke-session-other', 'ordinary-user')`,
        );
        expect(smokeSession.isErr()).toBe(true);
        if (smokeSession.isErr()) {
          expect(
            isPgConstraintError(
              smokeSession.error,
              PG_ERROR.CHECK_VIOLATION,
              "session_monitoring_principal_check",
            ),
          ).toBe(true);
        }
        await client`INSERT INTO member (id, user_id, organization_id) VALUES (${SYNTHETIC_PRINCIPAL.memberId}, ${SYNTHETIC_PRINCIPAL.user.id}, ${SYNTHETIC_PRINCIPAL.org.id})`;
        const invalidMembership = await Result.tryPromise(
          async () =>
            client`INSERT INTO member (id, user_id, organization_id) VALUES ('other-membership', ${SYNTHETIC_PRINCIPAL.user.id}, 'other-org')`,
        );
        expect(invalidMembership.isErr()).toBe(true);
        if (invalidMembership.isErr()) {
          expect(
            isPgConstraintError(
              invalidMembership.error,
              PG_ERROR.CHECK_VIOLATION,
              "member_synthetic_organization_check",
            ),
          ).toBe(true);
        }
        const changedMembership = await Result.tryPromise(
          async () =>
            client`UPDATE member SET organization_id = 'other-org' WHERE id = ${SYNTHETIC_PRINCIPAL.memberId}`,
        );
        expect(changedMembership.isErr()).toBe(true);
        if (changedMembership.isErr()) {
          expect(
            isPgConstraintError(
              changedMembership.error,
              PG_ERROR.CHECK_VIOLATION,
              "member_synthetic_organization_check",
            ),
          ).toBe(true);
        }
        const controls =
          await client`SELECT status FROM synthetic_session_control WHERE id = ${SYNTHETIC_SESSION_CONTROL_ID}`;
        expect(controls).toEqual([
          expect.objectContaining({ status: "enabled" }),
        ]);
        const policies =
          await client`SELECT polname FROM pg_policy WHERE polrelid = 'synthetic_session_control'::regclass`;
        expect(
          new Set(policies.map((row: { polname: string }) => row.polname)),
        ).toEqual(
          new Set(["synthetic_session_control_owner", "auth_no_stella_access"]),
        );
      } finally {
        await client.unsafe("SET search_path TO public");
        await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  });
});

describe.skipIf(!enabled)("monitoring session lifecycle", () => {
  test("repeated mints retain one organization and revocation ends session creation", async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    const { createSyntheticSessionStore } =
      await import("@/api/lib/synthetic-principal/store");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { sql: client, db } = openClient({ max: 1 });
      const schema = `monitoring_lifecycle_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      await client.unsafe(`CREATE SCHEMA ${schema}`);
      try {
        await client.unsafe(`SET search_path TO ${schema}, public`);
        // Derive fixture columns and indexes from the migrated production tables.
        for (const table of [
          "user",
          "organization",
          "member",
          "session",
          "synthetic_session_control",
          "organization_access_states",
          "agent_skills",
          "audit_logs",
          "account_audit_logs",
          "user_professional_use_acceptances",
          "organization_professional_use_acceptances",
          "system_audit_runs",
          "folio_collab_room_tokens",
        ]) {
          await client.unsafe(
            `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
          );
        }
        await client`INSERT INTO synthetic_session_control (id) VALUES (${SYNTHETIC_SESSION_CONTROL_ID})`;
        await client`INSERT INTO organization (id, name, slug, created_at) VALUES ('ordinary-org', 'Existing Organization', 'product-monitoring', now())`;
        await client`INSERT INTO organization (id, name, slug, created_at) VALUES (${SYNTHETIC_PRINCIPAL.org.id}, ${SYNTHETIC_PRINCIPAL.org.name}, ${SYNTHETIC_PRINCIPAL.org.slug}, now())`;
        const store = createSyntheticSessionStore(db);
        const request = {
          keyLabel: "test",
          requestId: "monitor-request",
          userAgent: "monitor-client",
        };
        const first = await store.mintSyntheticSession(request);
        const second = await store.mintSyntheticSession(request);
        expect(first).not.toBeNull();
        expect(second).not.toBeNull();
        if (!first || !second) {
          panic("Expected monitoring sessions");
        }
        expect(first.cookieValue).not.toBe(second.cookieValue);
        const auth = betterAuth({
          baseURL: "http://localhost:3001",
          secret: env.BETTER_AUTH_SECRET,
          database: drizzleAdapter(db, AUTH_DATABASE_ADAPTER_OPTIONS),
          advanced: authCookiePolicy(),
          session: {
            additionalFields: {
              activeOrganizationId: { type: "string", required: false },
            },
            cookieCache: { enabled: false },
          },
          plugins: [
            createReviewAccountPlugin({
              id: "monitoring-lifecycle-policy",
              config: syntheticPrincipalAuthConfig,
              localPasswordEnabled: true,
              checkAccess: checkSyntheticPrincipalAccess,
            }),
          ],
        });
        const resolveSession = async () =>
          await auth.api.getSession({
            query: { disableRefresh: true },
            headers: new Headers({
              cookie: `${first.cookieName}=${encodeURIComponent(first.cookieValue)}`,
            }),
          });
        expect(await resolveSession()).toMatchObject({
          user: { id: SYNTHETIC_PRINCIPAL.user.id },
          session: { activeOrganizationId: SYNTHETIC_PRINCIPAL.org.id },
        });
        const sessions =
          await client`SELECT user_id, active_organization_id, refresh_mode, user_agent, ip_address, extract(epoch from expires_at - created_at)::integer AS lifetime_seconds FROM session`;
        expect(sessions).toHaveLength(2);
        for (const row of sessions) {
          expect(row).toMatchObject({
            user_id: SYNTHETIC_PRINCIPAL.user.id,
            active_organization_id: SYNTHETIC_PRINCIPAL.org.id,
            refresh_mode: "fixed",
            user_agent: "stella-synthetic/prod",
            ip_address: "synthetic-monitor",
            lifetime_seconds: 1800,
          });
        }
        expect(
          await client`SELECT id FROM organization WHERE id = ${SYNTHETIC_PRINCIPAL.org.id}`,
        ).toEqual([
          expect.objectContaining({ id: SYNTHETIC_PRINCIPAL.org.id }),
        ]);
        expect(
          await client`SELECT id, slug FROM organization WHERE id = 'ordinary-org'`,
        ).toEqual([
          expect.objectContaining({
            id: "ordinary-org",
            slug: "product-monitoring",
          }),
        ]);
        expect(await client`SELECT id FROM member`).toHaveLength(1);
        expect(
          await client`SELECT organization_id FROM organization_access_states`,
        ).toEqual([
          expect.objectContaining({
            organization_id: SYNTHETIC_PRINCIPAL.org.id,
          }),
        ]);
        const audits =
          await client`SELECT performer_type, trigger_type, metadata FROM audit_logs WHERE action = 'synthetic.session_minted'`;
        expect(audits).toHaveLength(2);
        expect(audits.at(0)).toMatchObject({
          performer_type: "service",
          trigger_type: "system",
          metadata: {
            keyLabel: "test",
            requestId: "monitor-request",
            userAgent: "monitor-client",
            expiresAt: first.expiresAt,
          },
        });
        expect(await store.revokeSyntheticSessions()).toEqual({
          status: "revoked",
          deletedSessions: 2,
          deletedRoomTokens: 0,
        });
        expect(await store.mintSyntheticSession(request)).toBeNull();
        expect(await resolveSession()).toBeNull();
        expect(await client`SELECT id FROM session`).toHaveLength(0);
        expect(await store.getSyntheticSessionStatus()).toMatchObject({
          status: "revoked",
        });
        expect(await store.revokeSyntheticSessions()).toEqual({
          status: "revoked",
          deletedSessions: 0,
          deletedRoomTokens: 0,
        });
        await client`DELETE FROM synthetic_session_control`;
        expect(await store.mintSyntheticSession(request)).toBeNull();
        expect(await store.getSyntheticSessionStatus()).toEqual({
          status: "missing",
          updatedAt: null,
        });
      } finally {
        await client.unsafe("SET search_path TO public");
        await client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  });
});
