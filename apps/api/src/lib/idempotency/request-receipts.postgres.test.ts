import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { organization, user } from "@/api/db/auth-schema";
import { safeDbFromScoped } from "@/api/db/safe-db";
import type { ScopedDb } from "@/api/db/safe-db";
import { contacts } from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  claimRequestReceipt,
  completeRequestReceipt,
  fingerprintRequest,
  releaseRequestReceipt,
  runWithRequestReceipt,
  sweepExpiredRequestReceipts,
} from "@/api/lib/idempotency/request-receipts";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  NO_AUDIT,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const ORIGINAL_BODY = { name: "Original" };

const fingerprint = (body: unknown) =>
  fingerprintRequest({
    method: "POST",
    route: "/test/create",
    body,
    params: {},
    query: {},
  });

type Fixture = Parameters<Parameters<typeof withGatedTestClients>[1]>[0];
const withFixture = async (
  run: (fixture: ReturnType<typeof receiptFixture>) => Promise<void>,
) => {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? panic("DATABASE_URL required");
  await withGatedTestClients(databaseUrl, async (clients) => {
    const fixture = receiptFixture(clients);
    const { db, organizationId, otherOrganizationId, userId } = fixture;
    await db.insert(organization).values(
      [organizationId, otherOrganizationId].map((id) => ({
        id,
        name: "Receipt fixture",
        slug: id,
        createdAt: new Date(),
      })),
    );
    await db.insert(user).values({
      id: userId,
      name: "Receipt fixture",
      email: `${userId}@example.test`,
    });
    try {
      await run(fixture);
    } finally {
      await db
        .delete(organization)
        .where(inArray(organization.id, [organizationId, otherOrganizationId]));
      await db.delete(user).where(eq(user.id, userId));
    }
  });
};

const receiptFixture = ({ openClient }: Fixture) => {
  const { db } = openClient({ max: 4 });
  const organizationId = mintAuthProviderId<"organization">();
  const otherOrganizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const database = markRlsDatabase(db);
  const scopedDb = createScopedDb(database, [], organizationId, userId);
  const otherScopedDb = createScopedDb(
    database,
    [],
    otherOrganizationId,
    userId,
  );
  const claim = (body: unknown = ORIGINAL_BODY, now?: Date) =>
    claimRequestReceipt({
      scopedDb,
      organizationId,
      userId,
      key: "submit-intent",
      route: "/test/create",
      fingerprint: fingerprint(body),
      now,
    });
  const submit = <T>(run: () => Promise<T>, status = 201) =>
    runWithRequestReceipt({
      scopedDb,
      organizationId,
      userId,
      key: "submit-intent",
      route: "/test/create",
      fingerprint: fingerprint({ name: "Original" }),
      run,
      responseStatus: () => status,
    });
  return {
    db,
    organizationId,
    otherOrganizationId,
    userId,
    scopedDb,
    otherScopedDb,
    claim,
    submit,
  };
};

describe.skipIf(!enabled)("request receipt state machine (postgres)", () => {
  test("replays the first status and body without creating a second receipt", async () => {
    await withFixture(async ({ claim, scopedDb }) => {
      const first = await claim();
      expect(first.type).toBe("claimed");
      if (first.type !== "claimed") {
        panic("Initial request must claim the receipt");
      }
      const body = { id: "created-resource", nested: { value: [1, "two"] } };
      await completeRequestReceipt({
        scopedDb,
        id: first.id,
        status: 201,
        body,
      });
      expect(await claim()).toEqual({ type: "replay", status: 201, body });
      const rows = await scopedDb(
        async (tx) =>
          await tx.execute(sql`SELECT id FROM request_idempotency_receipts`),
      );
      expect(rows).toHaveLength(1);
    });
  });

  test("double submit creates one resource and replays the original transport response", async () => {
    await withFixture(async ({ submit, scopedDb, organizationId }) => {
      const create = async () =>
        await scopedDb(async (tx) => {
          const rows = await tx
            .insert(contacts)
            .values({
              id: createSafeId<"contact">(),
              organizationId,
              type: "person",
              displayName: "Idempotent create",
            })
            .returning({ id: contacts.id });
          return rows.at(0) ?? panic("Create must return its resource");
        });
      const first = await submit(create);
      const second = await submit(create);
      expect(second).toBeInstanceOf(Response);
      if (!(second instanceof Response)) {
        panic("Replay must use the stored response");
      }
      expect(second.status).toBe(201);
      expect(second.headers.get("Idempotency-Replayed")).toBe("true");
      expect(await second.json()).toEqual(first);
      expect(
        await scopedDb(
          async (tx) => await tx.select({ id: contacts.id }).from(contacts),
        ),
      ).toEqual([first]);
    });
  });

  test("handler failures release the pending key before propagating", async () => {
    await withFixture(async ({ submit, claim }) => {
      expect(
        await rejectionOf(
          submit(async () => {
            throw new HandlerError({
              status: 503,
              message: "Injected failure",
            });
          }),
        ),
      ).toMatchObject({ status: 503, message: "Injected failure" });
      expect((await claim()).type).toBe("claimed");
    });
  });

  test("safe handler path opts in only when a header exists and preserves replay and conflict responses", async () => {
    await withFixture(async ({ scopedDb, organizationId, userId, claim }) => {
      let creates = 0;
      const endpoint = createSafeRootHandler(
        {
          contract: "patch",
          permissions: { contact: ["create"] },
          accountAccess: ACCOUNT_ACCESS.sandbox,
          mcp: { type: "internal", reason: "health_infra" },
          idempotency: { type: "replay" },
        },
        async function* () {
          creates += 1;
          return Result.ok({ id: `resource-${creates}` });
        },
      );
      const invoke = (key: string | null, body: unknown = ORIGINAL_BODY) =>
        endpoint.handler(
          createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
            audit: NO_AUDIT,
            scopedDb,
            safeDb: safeDbFromScoped(scopedDb),
            session: { activeOrganizationId: organizationId },
            user: { id: userId },
            request: new Request("https://example.test/test/create", {
              method: "POST",
              headers: key === null ? {} : { "Idempotency-Key": key },
            }),
            route: "/test/create",
            body,
            params: {},
            query: {},
            set: { status: 201, headers: {} },
          }),
        );
      expect(await invoke(null)).toEqual({ id: "resource-1" });
      expect(await invoke(null)).toEqual({ id: "resource-2" });
      expect(await invoke("handler-intent")).toEqual({ id: "resource-3" });
      const replay = await invoke("handler-intent");
      expect(replay).toBeInstanceOf(Response);
      if (!(replay instanceof Response)) {
        panic("Safe handler replay must return stored response");
      }
      expect(replay.status).toBe(201);
      expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      expect(await replay.json()).toEqual({ id: "resource-3" });
      expect(
        await invoke("handler-intent", { name: "Different" }),
      ).toMatchObject({
        code: 422,
        response: { code: "idempotency_key_reused" },
      });
      expect((await claim()).type).toBe("claimed");
      expect(await invoke("submit-intent")).toMatchObject({
        code: 409,
        response: { code: "idempotency_in_progress" },
      });
      expect(creates).toBe(3);
    });
  });

  test("receipt persistence failure retains the claim after the handler succeeds", async () => {
    await withFixture(async ({ scopedDb, organizationId, userId, claim }) => {
      let transactions = 0;
      const unavailableOnCompletion: ScopedDb = async (fn) => {
        transactions += 1;
        if (transactions === 2) {
          throw new HandlerError({
            status: 503,
            message: "Receipt persistence unavailable",
          });
        }
        return await scopedDb(fn);
      };
      let effects = 0;
      expect(
        await rejectionOf(
          runWithRequestReceipt({
            scopedDb: unavailableOnCompletion,
            organizationId,
            userId,
            key: "submit-intent",
            route: "/test/create",
            fingerprint: fingerprint({ name: "Original" }),
            run: async () => {
              effects += 1;
              return { id: "created" };
            },
            responseStatus: () => 201,
          }),
        ),
      ).toMatchObject({ message: "Receipt persistence unavailable" });
      expect(effects).toBe(1);
      expect(await claim()).toEqual({ type: "in_progress" });
    });
  });

  test("non-success JSON responses release the pending key", async () => {
    await withFixture(async ({ submit, claim }) => {
      expect(await submit(async () => ({ error: "retry" }), 503)).toEqual({
        error: "retry",
      });
      expect((await claim()).type).toBe("claimed");
    });
  });

  test("commits one concurrent claim and rejects the other as in progress", async () => {
    await withFixture(async ({ claim }) => {
      const claims = await Promise.all([claim(), claim()]);
      expect(claims.map(({ type }) => type).toSorted()).toEqual([
        "claimed",
        "in_progress",
      ]);
    });
  });

  test("rejects a reused key with a different body before and after completion", async () => {
    await withFixture(async ({ claim, scopedDb }) => {
      const first = await claim();
      if (first.type !== "claimed") {
        panic("Initial request must claim the receipt");
      }
      expect(await claim({ name: "Different" })).toEqual({
        type: "key_reused",
      });
      await completeRequestReceipt({
        scopedDb,
        id: first.id,
        status: 201,
        body: { id: "first" },
      });
      expect(await claim({ name: "Different" })).toEqual({
        type: "key_reused",
      });
    });
  });

  test("releases a failed request so the same intent can claim again", async () => {
    await withFixture(async ({ claim, scopedDb }) => {
      const first = await claim();
      if (first.type !== "claimed") {
        panic("Initial request must claim the receipt");
      }
      await releaseRequestReceipt({ scopedDb, id: first.id });
      const retry = await claim();
      expect(retry.type).toBe("claimed");
      if (retry.type !== "claimed") {
        panic("Released request must be claimable");
      }
      expect(retry.id).not.toBe(first.id);
    });
  });

  test("takes over stale pending work and fences the expired owner", async () => {
    await withFixture(async ({ claim, scopedDb }) => {
      const first = await claim(undefined, new Date("2026-10-15T10:00:00Z"));
      if (first.type !== "claimed") {
        panic("Initial request must claim the receipt");
      }
      expect(await claim(undefined, new Date("2026-10-15T10:01:59Z"))).toEqual({
        type: "in_progress",
      });
      const takeover = await claim(undefined, new Date("2026-10-15T10:02:01Z"));
      expect(takeover.type).toBe("claimed");
      if (takeover.type !== "claimed") {
        panic("Expired request must be claimable");
      }
      expect(takeover.id).not.toBe(first.id);
      await releaseRequestReceipt({ scopedDb, id: first.id });
      await completeRequestReceipt({
        scopedDb,
        id: first.id,
        status: 201,
        body: { id: "expired" },
      });
      expect(await claim(undefined, new Date("2026-10-15T10:02:02Z"))).toEqual({
        type: "in_progress",
      });
      await completeRequestReceipt({
        scopedDb,
        id: takeover.id,
        status: 201,
        body: { id: "winner" },
      });
      expect(await claim()).toEqual({
        type: "replay",
        status: 201,
        body: { id: "winner" },
      });
    });
  });

  test("retention deletes expired receipts and preserves the replay window", async () => {
    await withFixture(async ({ db, claim, scopedDb }) => {
      const now = new Date("2026-10-15T10:00:00Z");
      const old = await claim(undefined, new Date("2026-10-14T09:59:59Z"));
      if (old.type !== "claimed") {
        panic("Initial request must claim the receipt");
      }
      expect(
        await sweepExpiredRequestReceipts({
          deadline: performance.now() + 30_000,
          db,
          now,
          signal: new AbortController().signal,
        }),
      ).toEqual({ deleted: 1, hasMore: false });
      expect(
        await scopedDb(
          async (tx) =>
            await tx.execute(sql`SELECT id FROM request_idempotency_receipts`),
        ),
      ).toEqual([]);
      await claim(undefined, new Date("2026-10-14T10:00:00Z"));
      expect(
        await sweepExpiredRequestReceipts({
          deadline: performance.now() + 30_000,
          db,
          now,
          signal: new AbortController().signal,
        }),
      ).toEqual({ deleted: 0, hasMore: false });
      expect(
        await scopedDb(
          async (tx) =>
            await tx.execute(sql`SELECT id FROM request_idempotency_receipts`),
        ),
      ).toHaveLength(1);
    });
  });

  test("retention resumes partially swept organization groups after the deadline", async () => {
    await withFixture(
      async ({ db, claim, otherScopedDb, otherOrganizationId, userId }) => {
        const old = new Date("2026-10-14T09:59:59Z");
        await claim(undefined, old);
        await claimRequestReceipt({
          scopedDb: otherScopedDb,
          organizationId: otherOrganizationId,
          userId,
          key: "other-intent",
          route: "/test/create",
          fingerprint: fingerprint(ORIGINAL_BODY),
          now: old,
        });
        let clockReads = 0;
        const interrupted = await sweepExpiredRequestReceipts({
          db,
          now: new Date("2026-10-15T10:00:00Z"),
          signal: new AbortController().signal,
          deadline: 100,
          elapsedMs: () => {
            clockReads += 1;
            return clockReads >= 5 ? 100 : 0;
          },
        });
        expect(interrupted).toEqual({ deleted: 1, hasMore: true });
        const resumed = await sweepExpiredRequestReceipts({
          db,
          now: new Date("2026-10-15T10:00:00Z"),
          signal: new AbortController().signal,
          deadline: performance.now() + 30_000,
        });
        expect(resumed).toEqual({ deleted: 1, hasMore: false });
      },
    );
  });

  test("RLS prevents another organization reading or deleting the receipt", async () => {
    await withFixture(async ({ claim, otherScopedDb, scopedDb }) => {
      const first = await claim();
      if (first.type !== "claimed") {
        panic("Initial request must claim the receipt");
      }
      expect(
        await otherScopedDb(
          async (tx) =>
            await tx.execute(sql`SELECT id FROM request_idempotency_receipts`),
        ),
      ).toEqual([]);
      expect(
        await otherScopedDb(
          async (tx) =>
            await tx.execute(
              sql`DELETE FROM request_idempotency_receipts WHERE id = ${first.id} RETURNING id`,
            ),
        ),
      ).toEqual([]);
      expect(
        await scopedDb(
          async (tx) =>
            await tx.execute(sql`SELECT id FROM request_idempotency_receipts`),
        ),
      ).toHaveLength(1);
    });
  });
});
