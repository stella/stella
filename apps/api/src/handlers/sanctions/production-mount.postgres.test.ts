import { Value } from "@sinclair/typebox/value";
import { makeSignature } from "better-auth/crypto";
import { RedisClient } from "bun";
import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { SANCTIONS_SOURCES } from "@stll/sanctions";
import type { SanctionsEntry } from "@stll/sanctions";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import {
  sanctionsSources,
  sanctionsEditions,
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
} from "@/api/db/schema";
import { getAuth } from "@/api/lib/auth";
import { toSafeId } from "@/api/lib/branded-types";
import { API_RATE_LIMITS } from "@/api/lib/limits";
import { sharedSanctionsMatcherPool } from "@/api/lib/lists/sanctions/matcher-pool";
import {
  SANCTIONS_SOURCE_CONFIG,
  sanctionsSourceIds,
} from "@/api/lib/lists/sanctions/source-config";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!runPostgresTests)("production sanctions mount", () => {
  test("production sanctions search is anonymous and independent of signed-in tenant context", async () => {
    if (databaseUrl === undefined) {
      throw new TypeError("DATABASE_URL is required");
    }
    const now = new Date();
    setSystemTime(now);
    const counters = new Map<string, number>();
    const connected = spyOn(RedisClient.prototype, "connect").mockResolvedValue(
      undefined,
    );
    const send = spyOn(RedisClient.prototype, "send").mockImplementation(
      async (command, args) => {
        if (command !== "EVAL") {
          throw new TypeError(`Unexpected Redis command ${command}`);
        }
        const key = String(args.at(2));
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return [count, 60_000];
      },
    );
    try {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db, sql: owner } = openClient();
        const snapshots = await db.select().from(sanctionsSources);
        const editions = sanctionsSourceIds().map((source) => ({
          source,
          id: toSafeId<"sanctionsEdition">(Bun.randomUUIDv7()),
        }));
        const tenants = ["CZ", "SK"].map((jurisdiction) => ({
          jurisdiction,
          id: Bun.randomUUIDv7(),
          user: Bun.randomUUIDv7(),
          token: Bun.randomUUIDv7(),
        }));
        const payload = {
          source: "eu",
          issuer: SANCTIONS_SOURCES.eu.issuer,
          sourceId: Bun.randomUUIDv7(),
          entityType: "person",
          names: [{ name: "Ivan Petrovich Sidorov", quality: "strong" }],
          birthDates: [],
          nationalities: [],
          identifiers: [],
          addresses: [],
          referenceNumber: null,
          programme: null,
          legalBasis: null,
          listedOn: null,
          sourceUrl: "https://lists.example/eu",
        } as const satisfies SanctionsEntry;
        const contentHash = hashSha256Hex(JSON.stringify(payload));
        try {
          for (const { source, id } of editions) {
            await db
              .insert(sanctionsSources)
              .values({
                id: source,
                issuer: SANCTIONS_SOURCE_CONFIG[source].issuer,
                markerUrl: SANCTIONS_SOURCE_CONFIG[source].markerUrl,
              })
              .onConflictDoNothing();
            await db.insert(sanctionsEditions).values({
              id,
              sourceId: source,
              markerKey: hashSha256Hex(id),
              contentHash: hashSha256Hex(`${id}:edition`),
              publishedAt: "2026-10-02",
              entryCount: source === "eu" ? 1 : 0,
              state: "ready",
            });
            await db
              .update(sanctionsSources)
              .set({
                activeEditionId: id,
                heldEditionId: null,
                heldGuardCode: null,
                heldAt: null,
                lastSuccessfulVerifiedAt: now,
                lastCheckedAt: now,
              })
              .where(eq(sanctionsSources.id, source));
          }
          await db
            .insert(sanctionsEntryPayloads)
            .values({ contentHash, payload });
          const eu = editions.find(({ source }) => source === "eu");
          if (eu === undefined) {
            throw new TypeError("Missing EU edition");
          }
          await db.insert(sanctionsEditionEntries).values({
            editionId: eu.id,
            sourceEntryId: payload.sourceId,
            contentHash,
          });
          for (const tenant of tenants) {
            await owner`INSERT INTO organization (id, name, slug, created_at) VALUES (${tenant.id}, 'Mount tenant', ${tenant.id}, now())`;
            await owner`INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES (${tenant.user}, 'Mount user', ${`${tenant.user}@example.invalid`}, true, now(), now())`;
            await owner`INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES (${Bun.randomUUIDv7()}, ${tenant.id}, ${tenant.user}, 'owner', now())`;
            await owner`INSERT INTO session (id, token, user_id, active_organization_id, expires_at, created_at, updated_at) VALUES (${Bun.randomUUIDv7()}, ${tenant.token}, ${tenant.user}, ${tenant.id}, ${new Date(now.getTime() + 86_400_000)}, now(), now())`;
            await owner`INSERT INTO organization_settings (id, organization_id, practice_jurisdictions) VALUES (${Bun.randomUUIDv7()}, ${tenant.id}, ${JSON.stringify([tenant.jurisdiction])}::text::jsonb)`;
          }
          const { publicSanctionsResponseSchema } =
            await import("@/api/handlers/sanctions/search-response");
          const { default: api } = await import("@/api/server");
          for (const { source, id } of editions) {
            const warmed = await sharedSanctionsMatcherPool.run(
              async (session) =>
                await session.match({
                  source,
                  editionId: id,
                  list: {
                    version: {
                      source,
                      publishedAt: "2026-10-02",
                      fileId: null,
                    },
                    entries: source === "eu" ? [payload] : [],
                  },
                  query: { name: "Cache Warmup", entityType: "organisation" },
                  cutoff: 0.8,
                  limit: 10,
                }),
              { deadlineMs: 10_000 },
            );
            expect(warmed?.status).toBe("screened");
          }
          const auth = getAuth();
          const authContext = await auth.$context;
          const cookies = await Promise.all(
            tenants.map(async (tenant) => {
              const cookie = `${authContext.authCookies.sessionToken.name}=${encodeURIComponent(`${tenant.token}.${await makeSignature(tenant.token, authContext.secret)}`)}`;
              const resolved = await auth.api.getSession({
                headers: new Headers({ cookie }),
              });
              expect(resolved?.session.activeOrganizationId).toBe(tenant.id);
              return cookie;
            }),
          );
          const expiredTenant = tenants.at(0);
          if (expiredTenant === undefined) {
            throw new TypeError("Missing session tenant");
          }
          const expiredToken = Bun.randomUUIDv7();
          await owner`INSERT INTO session (id, token, user_id, active_organization_id, expires_at, created_at, updated_at) VALUES (${Bun.randomUUIDv7()}, ${expiredToken}, ${expiredTenant.user}, ${expiredTenant.id}, ${new Date(now.getTime() - 86_400_000)}, now(), now())`;
          const expiredCookie = `${authContext.authCookies.sessionToken.name}=${encodeURIComponent(`${expiredToken}.${await makeSignature(expiredToken, authContext.secret)}`)}`;
          expect(
            await auth.api.getSession({
              headers: new Headers({ cookie: expiredCookie }),
            }),
          ).toBeNull();
          const search = async (cookie?: string) => {
            const response = await api.handle(
              new Request("http://localhost/v1/sanctions/search", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...(cookie === undefined ? {} : { cookie }),
                },
                body: JSON.stringify({
                  subject: {
                    type: "person",
                    firstName: "Ivan",
                    lastName: "Sidorov",
                  },
                }),
              }),
            );
            expect(response.headers.get(CACHE_CONTROL_HEADER)).toBe(
              PRIVATE_CACHE_CONTROL,
            );
            return response;
          };
          const outcomes: string[] = [];
          for (const cookie of [
            undefined,
            ...cookies,
            expiredCookie,
            `${authContext.authCookies.sessionToken.name}=invalid`,
          ]) {
            const response = await search(cookie);
            expect(response.status).toBe(200);
            const body = Value.Decode(
              publicSanctionsResponseSchema[200],
              await response.json(),
            );
            expect([
              ...Value.Errors(publicSanctionsResponseSchema[200], body),
            ]).toEqual([]);
            expect(body.status).toBe("possible-match");
            outcomes.push(JSON.stringify(body));
          }
          expect(outcomes.every((body) => body === outcomes.at(0))).toBe(true);
          let transportRequests = 0;
          for (const cookie of [undefined, cookies.at(0)]) {
            for (const malformed of [
              {
                contentType: "application/json",
                body: '{"subject":"PrivateParseQzxv",}',
                status: 400,
              },
              {
                contentType: "application/json",
                body: '{"subject":{"name":"PrivateParseQzxv"',
                status: 400,
              },
              {
                contentType: "application/octet-stream",
                body: "PrivateParseQzxv",
                status: 422,
              },
            ]) {
              const response = await api.handle(
                new Request("http://localhost/v1/sanctions/search", {
                  method: "POST",
                  headers: {
                    "content-type": malformed.contentType,
                    ...(cookie === undefined ? {} : { cookie }),
                  },
                  body: malformed.body,
                }),
              );
              expect(response.status).toBe(malformed.status);
              expect(response.headers.get(CACHE_CONTROL_HEADER)).toBe(
                PRIVATE_CACHE_CONTROL,
              );
              expect(await response.text()).not.toContain("PrivateParseQzxv");
              transportRequests += 1;
            }
          }
          for (
            let count = outcomes.length + transportRequests;
            count < API_RATE_LIMITS.publicSanctionsSearch.max;
            count += 1
          ) {
            expect(
              (await search(cookies.at(count % cookies.length))).status,
            ).toBe(200);
          }
          expect((await search(cookies.at(0))).status).toBe(429);
          expect((await search()).status).toBe(429);
        } finally {
          for (const tenant of tenants) {
            // Parent-first teardown lets owner memberships cascade after the organization is gone.
            await owner`DELETE FROM organization WHERE id = ${tenant.id}`;
            await owner`DELETE FROM "user" WHERE id = ${tenant.user}`;
          }
          for (const { source } of editions) {
            const snapshot = snapshots.find(({ id }) => id === source);
            await db
              .update(sanctionsSources)
              .set(snapshot ?? { activeEditionId: null })
              .where(eq(sanctionsSources.id, source));
          }
          await db.delete(sanctionsEditionEntries).where(
            inArray(
              sanctionsEditionEntries.editionId,
              editions.map(({ id }) => id),
            ),
          );
          await db
            .delete(sanctionsEntryPayloads)
            .where(eq(sanctionsEntryPayloads.contentHash, contentHash));
          await db.delete(sanctionsEditions).where(
            inArray(
              sanctionsEditions.id,
              editions.map(({ id }) => id),
            ),
          );
          const added = editions
            .filter(({ source }) => !snapshots.some(({ id }) => id === source))
            .map(({ source }) => source);
          if (added.length > 0) {
            await db
              .delete(sanctionsSources)
              .where(inArray(sanctionsSources.id, added));
          }
        }
      });
    } finally {
      await sharedSanctionsMatcherPool.close();
      send.mockRestore();
      connected.mockRestore();
      setSystemTime();
    }
  }, 120_000);
});
