import { PDF } from "@libpdf/core";
import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { entityVersions, pdfSigningSessions } from "@/api/db/schema";
import { createScopedDb, createTenantlessDb } from "@/api/db/scoped";
import { createSubmitPdfSigningSignatureHandler } from "@/api/handlers/entities/pdf-signing-signature";
import type { SubmitPdfSigningSignatureDependencies } from "@/api/handlers/entities/pdf-signing-signature";
import { createSafeId } from "@/api/lib/branded-types";
import { retryable } from "@/api/lib/files/pdf-signing/finalize";
import {
  authorizePdfSigningSession,
  createPdfSigningToken,
  hashPdfSigningToken,
  redeemPdfSigningHandoff,
} from "@/api/lib/files/pdf-signing/sessions";
import {
  captureSigningDigest,
  signaturePlaceholderSize,
} from "@/api/lib/files/pdf-signing/sign-pdf";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";
import { settled } from "@/api/tests/helpers/settled";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let tokenDb: TokenScopedDatabase;
let ids: TestIds;

/** DigestInfo header for SHA-256, RFC 8017 9.2 step 2. */
const SHA256_DIGEST_INFO_PREFIX = Buffer.from(
  "3031300d060960864801650304020105000420",
  "hex",
);

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  tokenDb = {
    scoped: ({ organizationId, userId, workspaceIds }) =>
      asTestRaw<ScopedDb>(
        createScopedDb(testDb, workspaceIds, organizationId, userId),
      ),
    tenantless: asTestRaw<TokenScopedDatabase["tenantless"]>(
      createTenantlessDb(testDb),
    ),
  };
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    await testDb
      .delete(pdfSigningSessions)
      .where(eq(pdfSigningSessions.workspaceId, ids.wsA1));
  } finally {
    await releaseRlsFixture();
  }
});

/**
 * An exchange whose phase 1 already ran, with a real certificate, real
 * signed attributes and the signature a keychain would return for them.
 */
const seedPreparedSession = async () => {
  const signingTime = new Date("2026-06-01T12:00:00.000Z");
  const { der, privateKey } = await createSelfSignedCertificate({
    notAfter: new Date(signingTime.getTime() + 3_600_000),
    notBefore: new Date(signingTime.getTime() - 3_600_000),
  });
  const created = PDF.create();
  created.addPage({ width: 300, height: 400 });
  const placeholderSize = signaturePlaceholderSize({
    certificate: der,
    certificateChain: [],
    timestamped: false,
  });
  const { digestHex, signedAttributes } = await settled(
    captureSigningDigest({
      basePdf: await created.save(),
      certificate: der,
      certificateChain: [],
      keyType: "RSA",
      location: null,
      placeholderSize,
      reason: null,
      reserveTimestamp: false,
      signatureAlgorithm: "RSASSA-PKCS1-v1_5",
      signingTime,
      stamp: null,
    }),
  );
  const key = crypto.createPrivateKey({
    key: Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)),
    format: "der",
    type: "pkcs8",
  });
  const signature = crypto.privateEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.concat([SHA256_DIGEST_INFO_PREFIX, Buffer.from(digestHex, "hex")]),
  );

  await testDb
    .delete(pdfSigningSessions)
    .where(eq(pdfSigningSessions.workspaceId, ids.wsA1));
  const sessionId = createSafeId<"pdfSigningSession">();
  const handoffToken = createPdfSigningToken();
  const expiresAt = new Date(Date.now() + 120_000);
  await testDb.insert(pdfSigningSessions).values({
    baseVersionId: ids.entityVersionA1,
    createdBy: ids.userA1,
    digestHex,
    entityId: ids.entityA1,
    handoffExpiresAt: expiresAt,
    handoffTokenHash: hashPdfSigningToken(handoffToken),
    id: sessionId,
    keyType: "RSA",
    placeholderSize,
    propertyId: ids.filePropertyA1,
    signedAttributes: Buffer.from(signedAttributes),
    signerCertificateChain: [],
    signerCertificateDer: Buffer.from(der),
    signingTime,
    tokenExpiresAt: expiresAt,
    workspaceId: ids.wsA1,
  });
  const redeemed = await redeemPdfSigningHandoff(handoffToken, tokenDb);
  return {
    sessionId,
    sessionToken: redeemed?.sessionToken ?? "",
    signature: signature.toString("base64"),
  };
};

/**
 * The real authorization against the test database, with the session's
 * database handle pointed at it too.
 */
const authorizeAgainstTestDb: SubmitPdfSigningSignatureDependencies["authorize"] =
  async (raw) => {
    const { sessionId, sessionToken } = asTestRaw<{
      sessionId: ReturnType<typeof createSafeId<"pdfSigningSession">>;
      sessionToken: string;
    }>(raw);
    const authorized = await authorizePdfSigningSession(
      { sessionId, sessionToken },
      tokenDb,
    );
    if (authorized.status === "finalized") {
      return Result.ok({
        kind: "finalized",
        versionId: authorized.versionId,
        versionNumber: authorized.versionNumber,
      });
    }
    if (authorized.status !== "authorized") {
      throw new Error(`unexpected authorization: ${authorized.status}`);
    }
    return Result.ok({
      kind: "open",
      session: {
        ...authorized.value,
        safeDb: toSafeDbMock(
          async (callback) => await callback(asTestRaw<Transaction>(testDb)),
        ),
      },
    });
  };

const readSession = async (sessionId: string) =>
  (
    await testDb
      .select({
        attempts: pdfSigningSessions.finalizeAttempts,
        lease: pdfSigningSessions.finalizeLeaseExpiresAt,
        signature: pdfSigningSessions.signature,
        status: pdfSigningSessions.status,
      })
      .from(pdfSigningSessions)
      .where(eq(pdfSigningSessions.id, asTestRaw(sessionId)))
  ).at(0);

describe("finalizing a PDF signature", () => {
  test("a transient failure keeps the signature, a retry finalizes, a repeat answers the same", async () => {
    const { sessionId, sessionToken, signature } = await seedPreparedSession();
    const versionNumber =
      (
        await testDb
          .select({ versionNumber: entityVersions.versionNumber })
          .from(entityVersions)
          .where(eq(entityVersions.id, ids.entityVersionA1))
      ).at(0)?.versionNumber ?? 0;

    // Phase 2 stands in for the document store: the first run fails
    // transiently, the second writes the version and finalizes the row the
    // way the real version write does, in the same place.
    const finalizedWith: string[] = [];
    const finalize: SubmitPdfSigningSignatureDependencies["finalize"] = async (
      options,
    ) => {
      finalizedWith.push(Buffer.from(options.signature).toString("base64"));
      if (finalizedWith.length === 1) {
        return Result.err(
          retryable(
            "pdf_signing_finalize_unavailable",
            "The signed document could not be stored. Try again.",
          ),
        );
      }
      await testDb
        .update(pdfSigningSessions)
        .set({ finalizedVersionId: ids.entityVersionA1, status: "finalized" })
        .where(eq(pdfSigningSessions.id, options.session.sessionId));
      return Result.ok({ versionId: ids.entityVersionA1, versionNumber });
    };
    const definition = createSubmitPdfSigningSignatureHandler({
      authorize: authorizeAgainstTestDb,
      finalize,
    });
    const post = async () =>
      await definition.handler(
        createTestHandlerContext<Parameters<typeof definition.handler>[0]>({
          body: { sessionToken, signature },
          params: { sessionId },
        }),
      );

    const first = await post();
    if (!(typeof first === "object" && first !== null && "code" in first)) {
      throw new Error("Expected the transient failure to return a status");
    }
    expect(first.code).toBe(503);
    expect(first.response).toMatchObject({
      code: "pdf_signing_finalize_unavailable",
    });
    const afterFailure = await readSession(sessionId);
    expect(afterFailure?.status).toBe("open");
    expect(afterFailure?.attempts).toBe(1);
    // The lease is back, so the retry below may start at once.
    expect(afterFailure?.lease).toBe(null);
    expect(Buffer.from(afterFailure?.signature ?? []).toString("base64")).toBe(
      signature,
    );

    const retried = await post();
    expect(retried).toEqual({ versionId: ids.entityVersionA1, versionNumber });
    expect(finalizedWith).toEqual([signature, signature]);

    // A repeat after the exchange finalized (a lost response, say) learns
    // the version and runs nothing again.
    const repeated = await post();
    expect(repeated).toEqual({ versionId: ids.entityVersionA1, versionNumber });
    expect(finalizedWith).toHaveLength(2);
  });

  test("a signature that does not verify closes the exchange before any embedding", async () => {
    const { sessionId, sessionToken } = await seedPreparedSession();
    let finalized = 0;
    const definition = createSubmitPdfSigningSignatureHandler({
      authorize: authorizeAgainstTestDb,
      finalize: async () => {
        finalized += 1;
        return Result.ok({ versionId: ids.entityVersionA1, versionNumber: 1 });
      },
    });

    const result = await definition.handler(
      createTestHandlerContext<Parameters<typeof definition.handler>[0]>({
        body: {
          sessionToken,
          signature: Buffer.alloc(256, 7).toString("base64"),
        },
        params: { sessionId },
      }),
    );

    if (!(typeof result === "object" && result !== null && "code" in result)) {
      throw new Error("Expected the refusal to return a status");
    }
    expect(result.code).toBe(422);
    expect(result.response).toMatchObject({
      code: "pdf_signing_signature_invalid",
    });
    expect(finalized).toBe(0);
    expect((await readSession(sessionId))?.status).toBe("cancelled");
  });
});
