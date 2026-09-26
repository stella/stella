import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import type { rootDb, Transaction } from "@/api/db/root";
import { pdfSigningSessions } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  claimFinalizeAttempt,
  MAX_FINALIZE_ATTEMPTS,
  releaseFinalizeAttempt,
  storeDesktopSignature,
} from "@/api/lib/pdf-signing/finalize-attempts";
import {
  authorizePdfSigningSession,
  createPdfSigningToken,
  hashPdfSigningToken,
  redeemPdfSigningHandoff,
} from "@/api/lib/pdf-signing/sessions";
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

type SeedOptions = {
  handoffExpiresAt?: Date;
  tenant?: "a" | "b";
};

const seedHandoff = async ({
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
      await storeDesktopSignature({ sessionId, signature, tx: store() }),
    ).toEqual({ status: "stored" });
    // Repeating the same signature is how a retry resends it.
    expect(
      await storeDesktopSignature({ sessionId, signature, tx: store() }),
    ).toEqual({ status: "stored" });
    expect(
      await storeDesktopSignature({
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
      await claimFinalizeAttempt({ now, sessionId, tx: store() });

    expect(await claim(start)).toEqual({ status: "claimed", attempt: 1 });
    // A retry racing a live attempt waits instead of embedding twice.
    expect(await claim(start)).toEqual({ status: "in-progress" });

    await releaseFinalizeAttempt({ sessionId, tx: store() });
    expect(await claim(start)).toEqual({ status: "claimed", attempt: 2 });

    // An attempt that died without releasing stops blocking once its lease
    // lapses.
    const afterLease = new Date(start.getTime() + 10 * MINUTE_MS);
    expect(await claim(afterLease)).toEqual({ status: "claimed", attempt: 3 });

    await releaseFinalizeAttempt({ sessionId, tx: store() });
    expect(MAX_FINALIZE_ATTEMPTS).toBe(3);
    expect(await claim(afterLease)).toEqual({ status: "exhausted" });
  });

  test("never claims or stores on a closed exchange", async () => {
    const { sessionId } = await seedHandoff();
    await testDb
      .update(pdfSigningSessions)
      .set({ closeReason: "user_cancelled", status: "cancelled" })
      .where(eq(pdfSigningSessions.id, sessionId));

    expect(
      await claimFinalizeAttempt({ now: new Date(), sessionId, tx: store() }),
    ).toEqual({ status: "closed" });
    expect(
      await storeDesktopSignature({
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
