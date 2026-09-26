import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import type { rootDb, Transaction } from "@/api/db/root";
import { entityVersions, pdfSigningSessions } from "@/api/db/schema";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { closePdfSigningSession } from "@/api/lib/files/pdf-signing/close-session";
import {
  claimFinalizeAttempt,
  MAX_FINALIZE_ATTEMPTS,
  releaseFinalizeAttempt,
  storeDesktopSignature,
} from "@/api/lib/files/pdf-signing/finalize-attempts";
import { storePreparedState } from "@/api/lib/files/pdf-signing/prepared-state";
import {
  authorizePdfSigningSession,
  createPdfSigningToken,
  hashPdfSigningToken,
  lockedCreatorAccess,
  openPdfSigningSession,
  redeemPdfSigningHandoff,
} from "@/api/lib/files/pdf-signing/sessions";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let db: typeof rootDb;
const createdSessionIds: SafeId<"pdfSigningSession">[] = [];

const MINUTE_MS = 60_000;

const recordedAuditEvents: AuditEvent[] = [];
const recordAuditEvent: AuditRecorder = async (_tx, event) => {
  recordedAuditEvents.push(...(Array.isArray(event) ? event : [event]));
};

type SeedOptions = {
  /** A creator other than the tenant's own member. */
  createdBy?: string;
  handoffExpiresAt?: Date;
  tenant?: "a" | "b";
};

const seedHandoff = async ({
  createdBy,
  handoffExpiresAt = new Date(Date.now() + 2 * MINUTE_MS),
  tenant = "a",
}: SeedOptions = {}) => {
  const sessionId = createSafeId<"pdfSigningSession">();
  const handoffToken = createPdfSigningToken();
  const tenantIds =
    tenant === "a"
      ? {
          baseVersionId: ids.entityVersionA1,
          createdBy: ids.userA1,
          entityId: ids.entityA1,
          propertyId: ids.filePropertyA1,
          workspaceId: ids.wsA1,
        }
      : {
          baseVersionId: ids.entityVersionB1,
          createdBy: ids.userB1,
          entityId: ids.entityB1,
          propertyId: ids.filePropertyB1,
          workspaceId: ids.wsB1,
        };

  // `pdf_signing_sessions_open_uidx` allows one open exchange per person per
  // file field, so each seeded row replaces the tenant's previous one.
  await testDb
    .delete(pdfSigningSessions)
    .where(eq(pdfSigningSessions.workspaceId, tenantIds.workspaceId));

  await testDb.insert(pdfSigningSessions).values({
    ...tenantIds,
    ...(createdBy !== undefined && { createdBy }),
    handoffExpiresAt,
    handoffTokenHash: hashPdfSigningToken(handoffToken),
    id: sessionId,
    tokenExpiresAt: handoffExpiresAt,
  });
  createdSessionIds.push(sessionId);

  return { handoffToken, sessionId, workspaceId: tenantIds.workspaceId };
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  db = asTestRaw<typeof rootDb>(testDb);
});

afterAll(async () => {
  try {
    if (createdSessionIds.length > 0) {
      await testDb
        .delete(pdfSigningSessions)
        .where(inArray(pdfSigningSessions.id, createdSessionIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("pdf signing handoff redemption", () => {
  test("mints a session token once and refuses every later redemption", async () => {
    const { handoffToken, sessionId } = await seedHandoff();

    const first = await redeemPdfSigningHandoff(handoffToken, db);
    expect(first).not.toBeNull();
    expect(first?.sessionId).toBe(sessionId);
    expect(first?.sessionToken).toMatch(/^[0-9a-f]{64}$/u);

    // The row itself arbitrates: the second attempt matches no row.
    expect(await redeemPdfSigningHandoff(handoffToken, db)).toBeNull();

    const rows = await testDb
      .select({
        handoffConsumedAt: pdfSigningSessions.handoffConsumedAt,
        sessionTokenHash: pdfSigningSessions.sessionTokenHash,
      })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, sessionId));
    expect(rows.at(0)?.handoffConsumedAt).not.toBeNull();
    expect(rows.at(0)?.sessionTokenHash).toBe(
      hashPdfSigningToken(first?.sessionToken ?? ""),
    );
  });

  test("refuses a handoff whose creator lost access before it was redeemed", async () => {
    // Tenant B's member holds no role in tenant A's workspace: the same
    // shape as a member removed after minting the link.
    const { handoffToken, sessionId } = await seedHandoff({
      createdBy: ids.userB1,
    });

    expect(await redeemPdfSigningHandoff(handoffToken, db)).toBeNull();

    const rows = await testDb
      .select({ sessionTokenHash: pdfSigningSessions.sessionTokenHash })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, sessionId));
    expect(rows.at(0)?.sessionTokenHash).toBeNull();
  });

  test("spends nothing unless the whole redemption commits", async () => {
    const { handoffToken, sessionId } = await seedHandoff();

    // Access check, consumption and descriptor read are one transaction:
    // failing at its very end leaves the handoff as it was.
    const failed = await redeemPdfSigningHandoff(handoffToken, db, {
      afterConsume: async () => {
        throw new Error("interrupted before commit");
      },
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);

    const rows = await testDb
      .select({
        handoffConsumedAt: pdfSigningSessions.handoffConsumedAt,
        sessionTokenHash: pdfSigningSessions.sessionTokenHash,
      })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, sessionId));
    expect(rows.at(0)).toEqual({
      handoffConsumedAt: null,
      sessionTokenHash: null,
    });
    // The same link still works once, as if the failed attempt never ran.
    expect(await redeemPdfSigningHandoff(handoffToken, db)).not.toBeNull();
  });

  test("locks the creator's access rows while redeeming", () => {
    // The row locks are what order a racing revocation against redemption;
    // assert they are taken rather than trusting a comment.
    const access = lockedCreatorAccess(asTestRaw<Transaction>(testDb), {
      createdBy: ids.userA1,
      organizationId: asTestRaw(ids.orgA),
      workspaceId: ids.wsA1,
    });
    for (const query of [access.role, access.membership]) {
      expect(query.toSQL().sql).toMatch(/ for share$/u);
    }
  });

  test("refuses a handoff whose deep link has expired", async () => {
    const { handoffToken, sessionId } = await seedHandoff({
      handoffExpiresAt: new Date(Date.now() - MINUTE_MS),
    });

    expect(await redeemPdfSigningHandoff(handoffToken, db)).toBeNull();

    const rows = await testDb
      .select({ sessionTokenHash: pdfSigningSessions.sessionTokenHash })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, sessionId));
    // A refused redemption must not leave a usable session token behind.
    expect(rows.at(0)?.sessionTokenHash).toBeNull();
  });

  test("refuses an unknown handoff token without touching other exchanges", async () => {
    const { sessionId } = await seedHandoff();

    expect(
      await redeemPdfSigningHandoff(createPdfSigningToken(), db),
    ).toBeNull();

    const rows = await testDb
      .select({ handoffConsumedAt: pdfSigningSessions.handoffConsumedAt })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, sessionId));
    expect(rows.at(0)?.handoffConsumedAt).toBeNull();
  });
});

describe("pdf signing session authorization", () => {
  test("scopes an authorized session to the workspace that owns it", async () => {
    const { handoffToken, sessionId, workspaceId } = await seedHandoff();
    const redeemed = await redeemPdfSigningHandoff(handoffToken, db);
    expect(redeemed).not.toBeNull();

    const authorized = await authorizePdfSigningSession(
      { sessionId, sessionToken: redeemed?.sessionToken ?? "" },
      db,
    );
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") {
      return;
    }
    expect(authorized.value.workspaceId).toBe(workspaceId);
    expect(authorized.value.userId).toBe(ids.userA1);
  });

  test("refuses another tenant's session token for this session", async () => {
    const mine = await seedHandoff();
    const theirs = await seedHandoff({ tenant: "b" });

    const redeemedMine = await redeemPdfSigningHandoff(mine.handoffToken, db);
    const redeemedTheirs = await redeemPdfSigningHandoff(
      theirs.handoffToken,
      db,
    );
    expect(redeemedMine?.sessionToken).toBeDefined();
    expect(redeemedTheirs?.sessionToken).toBeDefined();

    // Each token authorizes its own session, so the cross pairing below is
    // rejected for the pairing and not because either token is unusable.
    expect(
      (
        await authorizePdfSigningSession(
          {
            sessionId: theirs.sessionId,
            sessionToken: redeemedTheirs?.sessionToken ?? "",
          },
          db,
        )
      ).status,
    ).toBe("authorized");

    expect(
      (
        await authorizePdfSigningSession(
          {
            sessionId: mine.sessionId,
            sessionToken: redeemedTheirs?.sessionToken ?? "",
          },
          db,
        )
      ).status,
    ).toBe("missing");
  });

  test("refuses a session token past its own expiry", async () => {
    const { handoffToken, sessionId } = await seedHandoff();
    const redeemed = await redeemPdfSigningHandoff(handoffToken, db);

    await testDb
      .update(pdfSigningSessions)
      .set({ tokenExpiresAt: new Date(Date.now() - MINUTE_MS) })
      .where(eq(pdfSigningSessions.id, sessionId));

    expect(
      (
        await authorizePdfSigningSession(
          { sessionId, sessionToken: redeemed?.sessionToken ?? "" },
          db,
        )
      ).status,
    ).toBe("token-expired");
  });

  test("refuses a session the browser already cancelled", async () => {
    const { handoffToken, sessionId } = await seedHandoff();
    const redeemed = await redeemPdfSigningHandoff(handoffToken, db);

    await testDb
      .update(pdfSigningSessions)
      .set({ closeReason: "user_cancelled", status: "cancelled" })
      .where(eq(pdfSigningSessions.id, sessionId));

    expect(
      (
        await authorizePdfSigningSession(
          { sessionId, sessionToken: redeemed?.sessionToken ?? "" },
          db,
        )
      ).status,
    ).toBe("missing");
  });

  test("round-trips the signer certificate through the bytea column", async () => {
    const { handoffToken, sessionId } = await seedHandoff();
    const redeemed = await redeemPdfSigningHandoff(handoffToken, db);
    const certificate = new Uint8Array([0x30, 0x82, 0x00, 0xff, 0x00, 0x7f]);

    await testDb
      .update(pdfSigningSessions)
      .set({
        digestHex: "a".repeat(64),
        keyType: "RSA",
        signerCertificateChain: ["Zm9v"],
        signerCertificateDer: Buffer.from(certificate),
        signingTime: new Date("2026-06-01T12:00:00.000Z"),
      })
      .where(eq(pdfSigningSessions.id, sessionId));

    const authorized = await authorizePdfSigningSession(
      { sessionId, sessionToken: redeemed?.sessionToken ?? "" },
      db,
    );
    expect(authorized.status).toBe("authorized");
    if (authorized.status !== "authorized") {
      return;
    }
    expect([...(authorized.value.signerCertificateDer ?? [])]).toEqual([
      ...certificate,
    ]);
    expect(authorized.value.signerCertificateChain).toEqual(["Zm9v"]);
    expect(authorized.value.keyType).toBe("RSA");
  });
});

describe("pdf signing finalization attempts", () => {
  const store = () => asTestRaw<Transaction>(testDb);

  test("keeps the first signature and refuses a different one", async () => {
    const { sessionId } = await seedHandoff();
    const signature = new Uint8Array([1, 2, 3]);

    expect(
      await storeDesktopSignature({
        recordAuditEvent,
        sessionId,
        signature,
        tx: store(),
      }),
    ).toEqual({ status: "stored" });
    // Repeating the same signature is how a retry resends it.
    expect(
      await storeDesktopSignature({
        recordAuditEvent,
        sessionId,
        signature,
        tx: store(),
      }),
    ).toEqual({ status: "stored" });
    expect(
      await storeDesktopSignature({
        recordAuditEvent,
        sessionId,
        signature: new Uint8Array([9, 9, 9]),
        tx: store(),
      }),
    ).toEqual({ status: "conflict" });

    const rows = await testDb
      .select({ signature: pdfSigningSessions.signature })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, sessionId));
    expect([...(rows.at(0)?.signature ?? [])]).toEqual([1, 2, 3]);
  });

  test("leases each attempt and caps how many there are", async () => {
    const { sessionId } = await seedHandoff();
    const start = new Date();
    const claim = async (now: Date) =>
      await claimFinalizeAttempt({
        recordAuditEvent,
        now,
        sessionId,
        tx: store(),
      });

    expect(await claim(start)).toEqual({ status: "claimed", attempt: 1 });
    // A retry racing a live attempt waits instead of embedding twice.
    expect(await claim(start)).toEqual({ status: "in-progress" });

    await releaseFinalizeAttempt({
      recordAuditEvent,
      attempt: 1,
      sessionId,
      tx: store(),
    });
    expect(await claim(start)).toEqual({ status: "claimed", attempt: 2 });

    // An attempt that died without releasing stops blocking once its lease
    // lapses.
    const afterLease = new Date(start.getTime() + 10 * MINUTE_MS);
    expect(await claim(afterLease)).toEqual({ status: "claimed", attempt: 3 });

    await releaseFinalizeAttempt({
      recordAuditEvent,
      attempt: 3,
      sessionId,
      tx: store(),
    });
    expect(MAX_FINALIZE_ATTEMPTS).toBe(3);
    expect(await claim(afterLease)).toEqual({ status: "exhausted" });
  });

  test("an attempt that outlived its lease cannot disturb the one that took over", async () => {
    const { sessionId } = await seedHandoff();
    const start = new Date();
    const claim = async (now: Date) =>
      await claimFinalizeAttempt({
        recordAuditEvent,
        now,
        sessionId,
        tx: store(),
      });
    const lapsed = new Date(start.getTime() + 10 * MINUTE_MS);

    expect(await claim(start)).toEqual({ status: "claimed", attempt: 1 });
    // Attempt 1 runs past its lease; attempt 2 takes over.
    expect(await claim(lapsed)).toEqual({ status: "claimed", attempt: 2 });

    // Attempt 1 finally fails: its release and its close are both fenced
    // off, so attempt 2 keeps its lease and the exchange stays open.
    await releaseFinalizeAttempt({
      recordAuditEvent,
      attempt: 1,
      sessionId,
      tx: store(),
    });
    const closed = await closePdfSigningSession({
      attempt: 1,
      closeReason: "signing_failed",
      recordAuditEvent: async () => {
        await Promise.resolve();
      },
      safeDb: async (callback) => Result.ok(await callback(store())),
      sessionId,
    });
    expect(Result.isOk(closed)).toBe(true);
    expect(await claim(new Date(lapsed.getTime() + 1000))).toEqual({
      status: "in-progress",
    });
    const rows = await testDb
      .select({ status: pdfSigningSessions.status })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, sessionId));
    expect(rows.at(0)?.status).toBe("open");
  });

  test("the last attempt still running is in progress, not exhausted", async () => {
    const { sessionId } = await seedHandoff();
    const start = new Date();
    await testDb
      .update(pdfSigningSessions)
      .set({ finalizeAttempts: MAX_FINALIZE_ATTEMPTS - 1 })
      .where(eq(pdfSigningSessions.id, sessionId));

    expect(
      await claimFinalizeAttempt({
        recordAuditEvent,
        now: start,
        sessionId,
        tx: store(),
      }),
    ).toEqual({ status: "claimed", attempt: MAX_FINALIZE_ATTEMPTS });
    expect(
      await claimFinalizeAttempt({
        recordAuditEvent,
        now: start,
        sessionId,
        tx: store(),
      }),
    ).toEqual({ status: "in-progress" });
  });

  test("never claims or stores on a closed exchange", async () => {
    const { sessionId } = await seedHandoff();
    await testDb
      .update(pdfSigningSessions)
      .set({ closeReason: "user_cancelled", status: "cancelled" })
      .where(eq(pdfSigningSessions.id, sessionId));

    expect(
      await claimFinalizeAttempt({
        recordAuditEvent,
        now: new Date(),
        sessionId,
        tx: store(),
      }),
    ).toEqual({ status: "closed" });
    expect(
      await storeDesktopSignature({
        recordAuditEvent,
        sessionId,
        signature: new Uint8Array([1]),
        tx: store(),
      }),
    ).toEqual({ status: "closed" });
  });

  test("tells the token holder which version a finalized exchange produced", async () => {
    const { handoffToken, sessionId } = await seedHandoff();
    const redeemed = await redeemPdfSigningHandoff(handoffToken, db);
    await testDb
      .update(pdfSigningSessions)
      .set({ finalizedVersionId: ids.entityVersionA1, status: "finalized" })
      .where(eq(pdfSigningSessions.id, sessionId));

    const answered = await authorizePdfSigningSession(
      { sessionId, sessionToken: redeemed?.sessionToken ?? "" },
      db,
    );
    expect(answered.status).toBe("finalized");
    if (answered.status === "finalized") {
      expect(answered.versionId).toBe(ids.entityVersionA1);
    }

    // Anyone else still learns nothing.
    expect(
      (
        await authorizePdfSigningSession(
          { sessionId, sessionToken: createPdfSigningToken() },
          db,
        )
      ).status,
    ).toBe("missing");
  });
});

describe("opening a pdf signing exchange", () => {
  const openFor = async (now: Date) => {
    const id = createSafeId<"pdfSigningSession">();
    createdSessionIds.push(id);
    const expiresAt = new Date(now.getTime() + 2 * MINUTE_MS);
    const opened = await openPdfSigningSession({
      recordAuditEvent,
      now,
      tx: asTestRaw<Transaction>(testDb),
      values: {
        baseVersionId: ids.entityVersionA1,
        createdBy: ids.userA1,
        entityId: ids.entityA1,
        handoffExpiresAt: expiresAt,
        handoffTokenHash: hashPdfSigningToken(createPdfSigningToken()),
        id,
        propertyId: ids.filePropertyA1,
        tokenExpiresAt: expiresAt,
        workspaceId: ids.wsA1,
      },
    });
    return { id, opened };
  };

  test("opens only on the version that was checked, while it is current", async () => {
    await testDb
      .delete(pdfSigningSessions)
      .where(eq(pdfSigningSessions.workspaceId, ids.wsA1));
    // A version of the same document that is not its current one: what a
    // concurrent upload leaves the earlier checks pointing at.
    const stale = createSafeId<"entityVersion">();
    await testDb.insert(entityVersions).values({
      entityId: ids.entityA1,
      id: stale,
      versionNumber: 99,
      workspaceId: ids.wsA1,
    });
    try {
      const id = createSafeId<"pdfSigningSession">();
      const expiresAt = new Date(Date.now() + 2 * MINUTE_MS);
      const opened = await openPdfSigningSession({
        recordAuditEvent,
        now: new Date(),
        tx: asTestRaw<Transaction>(testDb),
        values: {
          baseVersionId: stale,
          createdBy: ids.userA1,
          entityId: ids.entityA1,
          handoffExpiresAt: expiresAt,
          handoffTokenHash: hashPdfSigningToken(createPdfSigningToken()),
          id,
          propertyId: ids.filePropertyA1,
          tokenExpiresAt: expiresAt,
          workspaceId: ids.wsA1,
        },
      });

      expect(opened).toEqual({ status: "version-changed" });
      const rows = await testDb
        .select({ id: pdfSigningSessions.id })
        .from(pdfSigningSessions)
        .where(eq(pdfSigningSessions.id, id));
      expect(rows).toEqual([]);
    } finally {
      await testDb.delete(entityVersions).where(eq(entityVersions.id, stale));
    }
  });

  test("a lapsed exchange no longer blocks the next one", async () => {
    await testDb
      .delete(pdfSigningSessions)
      .where(eq(pdfSigningSessions.workspaceId, ids.wsA1));
    const start = new Date();

    const first = await openFor(start);
    expect(first.opened).toEqual({ status: "created" });

    // While the first is live, a second click is refused, not forked.
    expect((await openFor(start)).opened).toEqual({ status: "in-progress" });

    // Past its TTL nothing swept it, yet the next attempt succeeds and the
    // dead one is closed with the reason the browser shows.
    const later = new Date(start.getTime() + 11 * MINUTE_MS);
    const second = await openFor(later);
    expect(second.opened).toEqual({ status: "created" });
    // The dead exchange's closing is recorded where it happens.
    expect(recordedAuditEvents).toContainEqual(
      expect.objectContaining({
        metadata: { closeReason: "expired" },
        resourceId: first.id,
      }),
    );
    const rows = await testDb
      .select({
        closeReason: pdfSigningSessions.closeReason,
        status: pdfSigningSessions.status,
      })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, first.id));
    expect(rows.at(0)).toEqual({ closeReason: "expired", status: "cancelled" });
  });
});

describe("storing phase 1's result", () => {
  const prepared = (certificate: number[], digestHex: string) => ({
    digestHex,
    keyType: "RSA" as const,
    placeholderSize: 16_384,
    signedAttributes: new Uint8Array([0x31, 0x00]),
    signerCertificateChain: [],
    signerCertificateDer: new Uint8Array(certificate),
    signingTime: new Date("2026-06-01T12:00:00.000Z"),
  });

  test("the first of two concurrent preparations wins and the second reads it back", async () => {
    const { sessionId } = await seedHandoff();
    const tx = asTestRaw<Transaction>(testDb);

    const [first, second] = await Promise.all([
      storePreparedState({
        recordAuditEvent,
        sessionId,
        tx,
        values: prepared([1, 2, 3], "a".repeat(64)),
      }),
      storePreparedState({
        recordAuditEvent,
        sessionId,
        tx,
        values: prepared([1, 2, 3], "b".repeat(64)),
      }),
    ]);
    const statuses = [first.status, second.status].toSorted();
    expect(statuses).toEqual(["already-prepared", "stored"]);

    const rows = await testDb
      .select({ digestHex: pdfSigningSessions.digestHex })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, sessionId));
    const winner = rows.at(0)?.digestHex;
    // The loser answers with the winner's digest, never its own.
    const loser = first.status === "stored" ? second : first;
    expect(loser).toEqual({ status: "already-prepared", digestHex: winner });
  });

  test("a different certificate cannot replace a stored preparation", async () => {
    const { sessionId } = await seedHandoff();
    const tx = asTestRaw<Transaction>(testDb);
    await storePreparedState({
      recordAuditEvent,
      sessionId,
      tx,
      values: prepared([1, 2, 3], "a".repeat(64)),
    });

    expect(
      await storePreparedState({
        recordAuditEvent,
        sessionId,
        tx,
        values: prepared([9, 9, 9], "c".repeat(64)),
      }),
    ).toEqual({ status: "conflict" });
    const rows = await testDb
      .select({ digestHex: pdfSigningSessions.digestHex })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, sessionId));
    expect(rows.at(0)?.digestHex).toBe("a".repeat(64));
  });
});

describe("pdf signing session row security", () => {
  /**
   * Row security is forced on the table, so its owner is held to the owner
   * policies. Runs as a non-superuser that owns the table, inside a
   * transaction rolled back at the end so the fixture keeps its owner.
   */
  const probe = async (
    role: "owner" | "application",
    run: (tx: Transaction) => Promise<void>,
  ): Promise<void> => {
    const rolledBack = new Error("roll back the probe");
    const outcome = await db
      .transaction(async (tx) => {
        if (role === "owner") {
          await tx.execute(sql`CREATE ROLE pdf_signing_owner_probe NOLOGIN`);
          await tx.execute(
            sql`ALTER TABLE pdf_signing_sessions OWNER TO pdf_signing_owner_probe`,
          );
          // The test database is pushed from the schema, which cannot say
          // "forced"; the migration does, and the policy baseline checks it.
          await tx.execute(
            sql`ALTER TABLE pdf_signing_sessions FORCE ROW LEVEL SECURITY`,
          );
          await tx.execute(sql`SET LOCAL ROLE pdf_signing_owner_probe`);
        } else {
          // No matter settings: only an owner policy could show a row.
          await tx.execute(sql`SET LOCAL ROLE stella`);
        }
        await run(tx);
        throw rolledBack;
      })
      .catch((error: unknown) => error);
    if (outcome !== rolledBack) {
      throw outcome;
    }
  };

  test("lets the owner read, spend an open handoff and delete, never insert", async () => {
    const { sessionId } = await seedHandoff();

    await probe("owner", async (tx) => {
      const visible = await tx
        .select({ id: pdfSigningSessions.id })
        .from(pdfSigningSessions)
        .where(eq(pdfSigningSessions.id, sessionId));
      expect(visible).toHaveLength(1);

      const spend = async () =>
        await tx
          .update(pdfSigningSessions)
          .set({ handoffConsumedAt: new Date() })
          .where(eq(pdfSigningSessions.id, sessionId))
          .returning({ id: pdfSigningSessions.id });
      expect(await spend()).toHaveLength(1);
      // Spent once, the handoff is out of the owner's reach for updates.
      expect(await spend()).toHaveLength(0);

      const deleted = await tx
        .delete(pdfSigningSessions)
        .where(eq(pdfSigningSessions.id, sessionId))
        .returning({ id: pdfSigningSessions.id });
      expect(deleted).toHaveLength(1);

      const handoffExpiresAt = new Date(Date.now() + MINUTE_MS);
      const inserted = await tx
        .insert(pdfSigningSessions)
        .values({
          baseVersionId: ids.entityVersionA1,
          createdBy: ids.userA1,
          entityId: ids.entityA1,
          handoffExpiresAt,
          handoffTokenHash: hashPdfSigningToken(createPdfSigningToken()),
          id: createSafeId<"pdfSigningSession">(),
          propertyId: ids.filePropertyA1,
          tokenExpiresAt: handoffExpiresAt,
          workspaceId: ids.wsA1,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(inserted).toBeInstanceOf(Error);
      expect(
        String(inserted instanceof Error ? inserted.cause : inserted),
      ).toMatch(/row-level security/u);
    });
  });

  test("gives the application role nothing through the owner policies", async () => {
    const { sessionId } = await seedHandoff();

    await probe("application", async (tx) => {
      const visible = await tx
        .select({ id: pdfSigningSessions.id })
        .from(pdfSigningSessions)
        .where(eq(pdfSigningSessions.id, sessionId));
      expect(visible).toHaveLength(0);
    });
  });
});
