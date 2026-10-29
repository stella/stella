import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { member, organization, user } from "@/api/db/auth-schema";
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
  runWithRequestReceipt,
  sweepExpiredRequestReceipts,
} from "@/api/lib/idempotency/request-receipts";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
} from "@/api/tests/helpers/handler-context";

import { authorizeOrganizationReplay } from "./organization-replay-authorization";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const REQUEST_FAILURE_CODE = "request_unavailable";
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

type SubmitOptions = { status?: number; now?: Date };

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
  const claim = async (body: unknown = ORIGINAL_BODY, now?: Date) =>
    await claimRequestReceipt({
      scopedDb,
      organizationId,
      userId,
      key: "submit-intent",
      route: "/test/create",
      fingerprint: fingerprint(body),
      ...(now === undefined ? {} : { now }),
    });
  const submit = async <T>(
    run: (scopedDb: ScopedDb) => Promise<T>,
    { status = 201, now }: SubmitOptions = {},
  ) =>
    await runWithRequestReceipt({
      scopedDb,
      organizationId,
      userId,
      key: "submit-intent",
      route: "/test/create",
      fingerprint: fingerprint({ name: "Original" }),
      run,
      responseStatus: () => status,
      ...(now === undefined ? {} : { now }),
    });
  const createContact = async (transactionalDb: ScopedDb) =>
    await transactionalDb(async (tx) => {
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
  return {
    db,
    organizationId,
    otherOrganizationId,
    userId,
    scopedDb,
    otherScopedDb,
    claim,
    submit,
    createContact,
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
    await withFixture(async ({ submit, scopedDb, createContact }) => {
      const first = (await submit(createContact)).unwrap();
      const second = (await submit(createContact)).unwrap();
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

  test("a thrown handler rolls back its resource and releases the key for a successful retry", async () => {
    await withFixture(async ({ submit, scopedDb, createContact }) => {
      expect(
        await rejectionOf(
          submit(async (database) => {
            await createContact(database);
            throw new HandlerError({
              status: 503,
              code: REQUEST_FAILURE_CODE,
              message: "Injected failure",
            });
          }),
        ),
      ).toMatchObject({ status: 503, message: "Injected failure" });
      expect(
        await scopedDb(
          async (tx) => await tx.select({ id: contacts.id }).from(contacts),
        ),
      ).toEqual([]);
      const first = (await submit(createContact)).unwrap();
      expect(
        await scopedDb(
          async (tx) => await tx.select({ id: contacts.id }).from(contacts),
        ),
      ).toEqual([first]);
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
        { authorize: async () => Result.ok(undefined) },
      );
      const invoke = async (
        key: string | null,
        body: unknown = ORIGINAL_BODY,
      ) =>
        await endpoint.handler(
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

  test("organization-only replay follows current organization membership", async () => {
    await withFixture(async ({ db, scopedDb, organizationId, userId }) => {
      await db.insert(member).values({
        id: Bun.randomUUIDv7(),
        organizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      });
      let calls = 0;
      const endpoint = createSafeRootHandler(
        {
          contract: "patch",
          permissions: { contact: ["create"] },
          accountAccess: ACCOUNT_ACCESS.sandbox,
          mcp: { type: "internal", reason: "health_infra" },
          idempotency: { type: "replay" },
        },
        async function* () {
          calls += 1;
          return Result.ok({ id: "created" });
        },
        { authorize: authorizeOrganizationReplay },
      );
      const invoke = async () =>
        await endpoint.handler(
          createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
            audit: NO_AUDIT,
            scopedDb,
            safeDb: safeDbFromScoped(scopedDb),
            session: { activeOrganizationId: organizationId },
            user: { id: userId },
            request: new Request("https://example.test/test/create", {
              method: "POST",
              headers: { "Idempotency-Key": "organization-only" },
            }),
            route: "/test/create",
            body: {},
            params: {},
            query: {},
            set: { status: 200, headers: {} },
          }),
        );
      expect(await invoke()).toEqual({ id: "created" });
      const stored = await invoke();
      expect(stored).toBeInstanceOf(Response);
      if (!(stored instanceof Response)) {
        panic("Expected stored organization response");
      }
      expect(await stored.json()).toEqual({ id: "created" });
      await db.delete(member).where(eq(member.userId, userId));
      expect(await invoke()).toMatchObject({
        code: 403,
        response: { message: "Organization membership required" },
      });
      expect(calls).toBe(1);
    });
  });

  test("safe handlers share the receipt transaction through both database handles", async () => {
    await withFixture(async ({ scopedDb, organizationId, userId }) => {
      let attempts = 0;
      const endpoint = createSafeRootHandler(
        {
          contract: "patch",
          permissions: { contact: ["create"] },
          accountAccess: ACCOUNT_ACCESS.sandbox,
          mcp: { type: "internal", reason: "health_infra" },
          idempotency: { type: "replay" },
        },
        async function* ({ safeDb, scopedDb: handlerDb }) {
          attempts += 1;
          const rows = yield* Result.await(
            safeDb(
              async (tx) =>
                await tx
                  .insert(contacts)
                  .values({
                    id: createSafeId<"contact">(),
                    organizationId,
                    type: "person",
                    displayName: "Atomic handler",
                  })
                  .returning({ id: contacts.id }),
            ),
          );
          const contact =
            rows.at(0) ?? panic("Create must return its resource");
          const visible = yield* Result.await(
            Result.tryPromise(
              async () =>
                await handlerDb(
                  async (tx) =>
                    await tx.select({ id: contacts.id }).from(contacts),
                ),
            ),
          );
          expect(visible).toEqual([contact]);
          if (attempts === 1) {
            return Result.err(
              new HandlerError({
                status: 503,
                code: REQUEST_FAILURE_CODE,
                message: "Retry the same intent",
              }),
            );
          }
          return Result.ok(contact);
        },
        { authorize: async () => Result.ok(undefined) },
      );
      const invoke = async () =>
        await endpoint.handler(
          createTestHandlerContext<Parameters<typeof endpoint.handler>[0]>({
            audit: NO_AUDIT,
            scopedDb,
            safeDb: safeDbFromScoped(scopedDb),
            session: { activeOrganizationId: organizationId },
            user: { id: userId },
            request: new Request("https://example.test/test/create", {
              method: "POST",
              headers: { "Idempotency-Key": "submit-intent" },
            }),
            route: "/test/create",
            body: ORIGINAL_BODY,
            params: {},
            query: {},
            set: { status: 201, headers: {} },
          }),
        );
      expect(await invoke()).toMatchObject({ code: 503 });
      expect(
        await scopedDb(
          async (tx) => await tx.select({ id: contacts.id }).from(contacts),
        ),
      ).toEqual([]);
      const created = await invoke();
      if (!("id" in created)) {
        panic("A successful retry must return its created contact");
      }
      expect(
        await scopedDb(
          async (tx) => await tx.select({ id: contacts.id }).from(contacts),
        ),
      ).toEqual([created]);
      const replay = await invoke();
      expect(replay).toBeInstanceOf(Response);
      expect(attempts).toBe(2);
    });
  });

  test("receipt completion failure rolls back the resource so a later retry creates exactly once", async () => {
    await withFixture(async ({ submit, scopedDb, createContact }) => {
      const startedAt = new Date("2026-10-15T10:00:00Z");
      // JSONB response persistence fails after the resource insert, inside the
      // same physical transaction; no completion collaborator is substituted.
      expect(
        await rejectionOf(
          submit(
            async (database) => ({
              ...(await createContact(database)),
              unpersistable: 1n,
            }),
            { now: startedAt },
          ),
        ),
      ).toBeInstanceOf(TypeError);
      expect(
        await scopedDb(
          async (tx) => await tx.select({ id: contacts.id }).from(contacts),
        ),
      ).toEqual([]);
      expect(
        await scopedDb(
          async (tx) =>
            await tx.execute(sql`SELECT id FROM request_idempotency_receipts`),
        ),
      ).toEqual([]);
      const first = (
        await submit(createContact, { now: new Date("2026-10-15T10:02:01Z") })
      ).unwrap();
      expect(
        await scopedDb(
          async (tx) => await tx.select({ id: contacts.id }).from(contacts),
        ),
      ).toEqual([first]);
    });
  });

  test("non-success responses roll back their writes and let the same key succeed on retry", async () => {
    for (const status of [400, 503]) {
      await withFixture(async ({ submit, scopedDb, createContact }) => {
        expect(
          (
            await submit(
              async (database) => {
                await createContact(database);
                return { error: "retry" };
              },
              { status },
            )
          ).unwrap(),
        ).toEqual({ error: "retry" });
        expect(
          await scopedDb(
            async (tx) => await tx.select({ id: contacts.id }).from(contacts),
          ),
        ).toEqual([]);
        const first = (await submit(createContact)).unwrap();
        expect(
          await scopedDb(
            async (tx) => await tx.select({ id: contacts.id }).from(contacts),
          ),
        ).toEqual([first]);
      });
    }
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

  test("a slow original handler keeps exclusive execution after the pending timeout", async () => {
    await withFixture(async ({ db, submit, createContact, scopedDb }) => {
      const startedAt = new Date("2026-10-15T10:00:00Z");
      const retryAt = new Date("2026-10-15T10:02:01Z");
      const entered = Promise.withResolvers<undefined>();
      const finish = Promise.withResolvers<undefined>();
      let effects = 0;
      const original = submit(
        async (database) => {
          entered.resolve(undefined);
          await finish.promise;
          effects += 1;
          return await createContact(database);
        },
        { now: startedAt },
      );
      await entered.promise;
      try {
        expect(
          await sweepExpiredRequestReceipts({
            db,
            now: retryAt,
            signal: new AbortController().signal,
            deadline: performance.now() + 30_000,
          }),
        ).toEqual({ deleted: 0, hasMore: false });
        const retry = await submit(
          async (database) => {
            effects += 1;
            return await createContact(database);
          },
          { now: retryAt },
        );
        expect(retry.isErr()).toBe(true);
        if (retry.isErr()) {
          expect(retry.error.code).toBe("idempotency_in_progress");
        }
        expect(effects).toBe(0);
      } finally {
        finish.resolve(undefined);
      }
      const first = (await original).unwrap();
      expect(effects).toBe(1);
      expect(
        await scopedDb(
          async (tx) => await tx.select({ id: contacts.id }).from(contacts),
        ),
      ).toEqual([first]);
      const replay = (
        await submit(
          async (database) => {
            effects += 1;
            return await createContact(database);
          },
          { now: retryAt },
        )
      ).unwrap();
      expect(replay).toBeInstanceOf(Response);
      if (!(replay instanceof Response)) {
        panic("Settled request must replay its stored response");
      }
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(first);
      expect(effects).toBe(1);
    });
  });

  test("retention removes abandoned pending work after two minutes so the intent can run", async () => {
    await withFixture(
      async ({ db, claim, submit, createContact, scopedDb }) => {
        const startedAt = new Date("2026-10-15T10:00:00Z");
        expect((await claim(undefined, startedAt)).type).toBe("claimed");
        const sweep = async (now: Date) =>
          await sweepExpiredRequestReceipts({
            db,
            now,
            signal: new AbortController().signal,
            deadline: performance.now() + 30_000,
          });
        expect(await sweep(new Date("2026-10-15T10:02:00Z"))).toEqual({
          deleted: 0,
          hasMore: false,
        });
        expect(await sweep(new Date("2026-10-15T10:02:01Z"))).toEqual({
          deleted: 1,
          hasMore: false,
        });
        const first = (await submit(createContact)).unwrap();
        expect(
          await scopedDb(
            async (tx) => await tx.select({ id: contacts.id }).from(contacts),
          ),
        ).toEqual([first]);
      },
    );
  });

  test("retention discovery locks receipts without granting unscoped writes", async () => {
    await withFixture(async ({ db, claim }) => {
      const first = await claim();
      if (first.type !== "claimed") {
        panic("Initial request must claim the receipt");
      }
      const locked = await db.transaction(
        async (tx) =>
          await tx.execute(sql`
            SELECT id FROM request_idempotency_receipts
            WHERE id = ${first.id} FOR UPDATE SKIP LOCKED
          `),
      );
      expect(locked).toEqual([{ id: first.id }]);
      const failure = await rejectionOf(
        db.execute(sql`
          UPDATE request_idempotency_receipts SET claimed_at = claimed_at
          WHERE id = ${first.id}
        `),
      );
      expect(getPgErrorCode(failure)).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
      expect(
        await db.execute(sql`
          DELETE FROM request_idempotency_receipts WHERE id = ${first.id}
          RETURNING id
        `),
      ).toEqual([]);
      expect(await claim()).toEqual({ type: "in_progress" });
    });
  });

  test("retention deletes expired receipts and preserves the replay window", async () => {
    await withFixture(async ({ db, claim, scopedDb }) => {
      const now = new Date("2026-10-15T10:00:00Z");
      const old = await claim(undefined, new Date("2026-10-14T09:59:59Z"));
      if (old.type !== "claimed") {
        panic("Initial request must claim the receipt");
      }
      await completeRequestReceipt({
        scopedDb,
        id: old.id,
        status: 201,
        body: {},
      });
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
      const recent = await claim(undefined, new Date("2026-10-14T10:00:00Z"));
      if (recent.type !== "claimed") {
        panic("Recent request must claim the receipt");
      }
      await completeRequestReceipt({
        scopedDb,
        id: recent.id,
        status: 201,
        body: {},
      });
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

  test("retention deletes a whole principal batch and resumes other organizations", async () => {
    await withFixture(
      async ({
        db,
        claim,
        scopedDb,
        otherScopedDb,
        organizationId,
        otherOrganizationId,
        userId,
      }) => {
        const old = new Date("2026-10-14T09:59:59Z");
        const first = await claim(undefined, old);
        if (first.type !== "claimed") {
          panic("Initial request must claim the receipt");
        }
        await completeRequestReceipt({
          scopedDb,
          id: first.id,
          status: 201,
          body: {},
        });
        const samePrincipal = await claimRequestReceipt({
          scopedDb,
          organizationId,
          userId,
          key: "same-principal-intent",
          route: "/test/create",
          fingerprint: fingerprint(ORIGINAL_BODY),
          now: old,
        });
        if (samePrincipal.type !== "claimed") {
          panic("Second receipt must be claimed");
        }
        await completeRequestReceipt({
          scopedDb,
          id: samePrincipal.id,
          status: 201,
          body: {},
        });
        const second = await claimRequestReceipt({
          scopedDb: otherScopedDb,
          organizationId: otherOrganizationId,
          userId,
          key: "other-intent",
          route: "/test/create",
          fingerprint: fingerprint(ORIGINAL_BODY),
          now: old,
        });
        if (second.type !== "claimed") {
          panic("Other request must claim the receipt");
        }
        await completeRequestReceipt({
          scopedDb: otherScopedDb,
          id: second.id,
          status: 201,
          body: {},
        });
        const firstBatch = await sweepExpiredRequestReceipts({
          db,
          now: new Date("2026-10-15T10:00:00Z"),
          signal: new AbortController().signal,
          deadline: 100,
          elapsedMs: () => 0,
        });
        expect(firstBatch.hasMore).toBe(true);
        expect([1, 2]).toContain(firstBatch.deleted);
        const remaining = await Promise.all([
          scopedDb(
            async (tx) =>
              await tx.execute(
                sql`SELECT id FROM request_idempotency_receipts`,
              ),
          ),
          otherScopedDb(
            async (tx) =>
              await tx.execute(
                sql`SELECT id FROM request_idempotency_receipts`,
              ),
          ),
        ]);
        expect(remaining.map((rows) => rows.length)).toEqual(
          firstBatch.deleted === 2 ? [0, 1] : [2, 0],
        );
        const resumed = await sweepExpiredRequestReceipts({
          db,
          now: new Date("2026-10-15T10:00:00Z"),
          signal: new AbortController().signal,
          deadline: performance.now() + 30_000,
        });
        expect(resumed).toEqual({
          deleted: 3 - firstBatch.deleted,
          hasMore: false,
        });
      },
    );
  });

  test("retention leaves discovered receipts for continuation when its budget expires", async () => {
    await withFixture(async ({ db, claim }) => {
      expect(
        (await claim(undefined, new Date("2026-10-15T09:57:59Z"))).type,
      ).toBe("claimed");
      let clockReads = 0;
      expect(
        await sweepExpiredRequestReceipts({
          db,
          now: new Date("2026-10-15T10:00:00Z"),
          signal: new AbortController().signal,
          deadline: 100,
          elapsedMs: () => {
            clockReads += 1;
            return clockReads >= 2 ? 100 : 0;
          },
        }),
      ).toEqual({ deleted: 0, hasMore: true });
      expect(await claim()).toEqual({ type: "in_progress" });
      expect(
        await sweepExpiredRequestReceipts({
          db,
          now: new Date("2026-10-15T10:00:00Z"),
          signal: new AbortController().signal,
          deadline: performance.now() + 30_000,
        }),
      ).toEqual({ deleted: 1, hasMore: false });
    });
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
