/**
 * PDF signing finalize holds the signer's current authority before the
 * version writer's matter and document locks, in the member → assignment →
 * matter order access changes take. A revocation that holds the member row
 * therefore finds the matter and document unlocked, and the finalize that
 * waited for it publishes nothing.
 */

import { PDF } from "@libpdf/core";
import { panic, Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import crypto from "node:crypto";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  pdfSigningSessions,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import {
  createSafeDb,
  createScopedDb,
  createTenantlessDb,
  markRlsDatabase,
} from "@/api/db/scoped";
import { env } from "@/api/env";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { createSafeId } from "@/api/lib/branded-types";
import { allocateFileObject } from "@/api/lib/files/file-object-ids";
import { finalizeSignature } from "@/api/lib/files/pdf-signing/finalize";
import {
  authorizePdfSigningSession,
  createPdfSigningToken,
  hashPdfSigningToken,
} from "@/api/lib/files/pdf-signing/sessions";
import {
  captureSigningDigest,
  signaturePlaceholderSize,
} from "@/api/lib/files/pdf-signing/sign-pdf";
import { createFileKey } from "@/api/lib/files/utils";
import type { TokenScopedDatabase } from "@/api/lib/root-scoped-db";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { createSelfSignedCertificate } from "@/api/tests/helpers/self-signed-certificate";
import { createTestRsaKeyPool } from "@/api/tests/helpers/test-pki";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

// timeout: three PostgreSQL sessions race a signed-version write through a lock barrier, after a real signature embed.
setDefaultTimeout(120_000);

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests =
  process.env["STELLA_RUN_POSTGRES_TESTS"] === "true" &&
  databaseUrl !== undefined;
const state = createTestState({ file: import.meta.path, config: env });
const keyPool = createTestRsaKeyPool();
const BUCKET = process.env["S3_BUCKET"] ?? "stella";
const MINUTE_MS = 60_000;

/** DigestInfo header for SHA-256, RFC 8017 9.2 step 2. */
const SHA256_DIGEST_INFO_PREFIX = Buffer.from(
  "3031300d060960864801650304020105000420",
  "hex",
);

/** The desktop half: a keychain signs phase 1's digest with PKCS#1 v1.5. */
const signDigestLikeAKeychain = async (
  privateKey: CryptoKey,
  digestHex: string,
) => {
  const key = crypto.createPrivateKey({
    key: Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)),
    format: "der",
    type: "pkcs8",
  });
  return new Uint8Array(
    crypto.privateEncrypt(
      { key, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.concat([SHA256_DIGEST_INFO_PREFIX, Buffer.from(digestHex, "hex")]),
    ),
  );
};

const pidColumns = { pid: sql<number>`pg_backend_pid()` };
const identity = sql`(SELECT 1) AS backend_identity`;
const backendPid = (rows: { pid: number }[]) =>
  rows.at(0)?.pid ?? panic("Backend identity missing");

describe.skipIf(!runPostgresTests)("pdf signing finalize authority", () => {
  test("a revocation holding the signer's member row finds the matter unlocked and refuses the signed version", async () => {
    // Phase 2 adds no timestamp unless an authority is configured.
    state.setConfig("PDF_SIGNING_TSA_URLS", undefined);
    state.setConfig("PDF_SIGNING_TSA_URL", undefined);
    const priorFileUsageFlag =
      envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS;
    envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS = false;
    const storage = startFakeS3();
    try {
      await withGatedTestClients(
        databaseUrl ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const setup = openClient({ max: 1 });
          const finalizer = openClient({ max: 1 });
          const revoker = openClient({ max: 1 });
          const organizationId = mintAuthProviderId<"organization">();
          const userId = mintAuthProviderId<"user">();
          const memberId = Bun.randomUUIDv7();
          const workspaceId = createSafeId<"workspace">();
          const entityId = createSafeId<"entity">();
          const baseVersionId = createSafeId<"entityVersion">();
          const propertyId = createSafeId<"property">();
          const sessionId = createSafeId<"pdfSigningSession">();
          const fileId = allocateFileObject();
          try {
            await setup.db.insert(organization).values({
              id: organizationId,
              name: "Signing authority",
              slug: organizationId,
              createdAt: new Date(),
            });
            await recordNewOrganizationAccessState(setup.db, {
              organizationId,
              now: new Date(),
            });
            await setup.db.insert(user).values({
              id: userId,
              name: "Signer",
              email: `${userId}@example.test`,
            });
            await setup.db.insert(member).values({
              id: memberId,
              organizationId,
              userId,
              role: "member",
              createdAt: new Date(),
            });
            await setup.db.insert(workspaces).values({
              id: workspaceId,
              organizationId,
              name: "Signing matter",
              reference: workspaceId,
            });
            await setup.db
              .insert(workspaceMembers)
              .values({ workspaceId, userId });

            // The stored base PDF the exchange was opened on.
            const created = PDF.create();
            created.addPage({ width: 300, height: 400 });
            const basePdf = await created.save();
            storage.put(
              BUCKET,
              createFileKey({
                organizationId,
                workspaceId,
                fileId,
                mimeType: PDF_MIME_TYPE,
              }),
              basePdf,
              PDF_MIME_TYPE,
            );
            await setup.db.insert(entities).values({
              id: entityId,
              workspaceId,
              name: "Agreement",
              kind: "document",
            });
            await setup.db.insert(entityVersions).values({
              id: baseVersionId,
              entityId,
              workspaceId,
              versionNumber: 1,
            });
            await setup.db
              .update(entities)
              .set({ currentVersionId: baseVersionId })
              .where(eq(entities.id, entityId));
            await setup.db.insert(properties).values({
              id: propertyId,
              workspaceId,
              name: "File",
              content: { type: "file", version: 1 },
              tool: { type: "manual-input", version: 1 },
              status: "fresh",
              system: true,
              kinds: ["document"],
            });
            await setup.db.insert(fields).values({
              id: createSafeId<"field">(),
              workspaceId,
              entityVersionId: baseVersionId,
              propertyId,
              content: {
                type: "file",
                version: 1,
                id: fileId,
                fileName: "agreement.pdf",
                mimeType: PDF_MIME_TYPE,
                sizeBytes: basePdf.byteLength,
                sha256Hex: hashSha256Hex(basePdf),
                encrypted: false,
                pdfFileId: null,
              },
            });

            // Phase 1 as the certificate handler runs it, then the desktop's
            // signature, stored on an exchange whose first attempt is claimed.
            const signingTime = new Date(Date.now() - MINUTE_MS);
            const { der, privateKey } = await createSelfSignedCertificate({
              keyPool,
              notBefore: new Date(signingTime.getTime() - 60 * MINUTE_MS),
              notAfter: new Date(signingTime.getTime() + 60 * MINUTE_MS),
            });
            const placeholderSize = signaturePlaceholderSize({
              certificate: der,
              certificateChain: [],
              timestamped: false,
            });
            const captured = await captureSigningDigest({
              basePdf,
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
            });
            if (Result.isError(captured)) {
              return panic("Phase 1 could not prepare the fixture PDF");
            }
            const { digestHex, signedAttributes } = captured.value;
            const signature = await signDigestLikeAKeychain(
              privateKey,
              digestHex,
            );
            const sessionToken = createPdfSigningToken({ userId: null });
            const expiresAt = new Date(Date.now() + 10 * MINUTE_MS);
            // Signing sessions are tenant rows: seed and read them in scope.
            const sessionScope = createScopedDb(
              markRlsDatabase(setup.db),
              [workspaceId],
              organizationId,
              userId,
            );
            await sessionScope(
              async (tx) =>
                await tx.insert(pdfSigningSessions).values({
                  id: sessionId,
                  workspaceId,
                  entityId,
                  propertyId,
                  baseVersionId,
                  createdBy: userId,
                  handoffTokenHash: hashPdfSigningToken(
                    createPdfSigningToken({ userId: null }),
                  ),
                  handoffExpiresAt: expiresAt,
                  handoffConsumedAt: new Date(),
                  sessionTokenHash: hashPdfSigningToken(sessionToken),
                  tokenExpiresAt: expiresAt,
                  digestHex,
                  keyType: "RSA",
                  placeholderSize,
                  signedAttributes: Buffer.from(signedAttributes),
                  signerCertificateChain: [],
                  signerCertificateDer: Buffer.from(der),
                  signingTime,
                  signature: Buffer.from(signature),
                  finalizeAttempts: 1,
                  finalizeLeaseExpiresAt: expiresAt,
                }),
            );

            // The finalize handler's own authorization, on the finalizer's
            // connection so its lock waits can be observed.
            const finalizerDb = markRlsDatabase(finalizer.db);
            const tokenDb = asTestRaw<TokenScopedDatabase>({
              scoped: (scope: {
                organizationId: typeof organizationId;
                userId: typeof userId;
                workspaceIds: (typeof workspaceId)[];
              }) =>
                createScopedDb(
                  finalizerDb,
                  scope.workspaceIds,
                  scope.organizationId,
                  scope.userId,
                ),
              tenantless: createTenantlessDb(finalizerDb),
            });
            const authorized = await authorizePdfSigningSession(
              { sessionId, sessionToken },
              tokenDb,
            );
            if (authorized.status !== "authorized") {
              return panic(`Signing session was ${authorized.status}`);
            }
            const session = {
              ...authorized.value,
              // The same tenant scope `authorizePdfSigningSession` builds on
              // the root pool, held on the observed connection.
              safeDb: asTestRaw<SafeDb>(
                createSafeDb(
                  finalizerDb,
                  [workspaceId],
                  organizationId,
                  userId,
                ),
              ),
            };
            const finalizerPid = backendPid(
              await finalizer.db.select(pidColumns).from(identity),
            );

            // The access change: the member row first, then the matter.
            const revokerHolds = Promise.withResolvers<number>();
            const releaseRevoker = Promise.withResolvers<undefined>();
            const revocation = revoker.db.transaction(async (tx) => {
              await tx
                .select({ id: member.id })
                .from(member)
                .where(eq(member.id, memberId))
                .for("no key update");
              revokerHolds.resolve(
                backendPid(await tx.select(pidColumns).from(identity)),
              );
              await releaseRevoker.promise;
              // The finalizer waits on the member row holding no matter or
              // document lock, so neither statement waits on it.
              await tx
                .select({ id: workspaces.id })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId))
                .for("update", { noWait: true });
              await tx
                .select({ id: entities.id })
                .from(entities)
                .where(
                  and(
                    eq(entities.id, entityId),
                    eq(entities.workspaceId, workspaceId),
                  ),
                )
                .for("update", { noWait: true });
              await tx
                .update(member)
                .set({ role: "external" })
                .where(eq(member.id, memberId));
            });
            const revokerPid = await Promise.race([
              revokerHolds.promise,
              revocation.then(() => null),
            ]);
            if (revokerPid === null) {
              return panic("The revocation committed before its barrier");
            }

            const finalized = finalizeSignature({
              attempt: 1,
              permit: grantThirdPartyOutboundPermit(),
              prepared: {
                digestHex,
                keyType: "RSA",
                placeholderSize,
                signedAttributes,
                signerCertificateDer: der,
                signingTime,
              },
              recordAuditEvent: async () => undefined,
              session,
              signature,
            });
            try {
              await waitForBlockedPid(setup.sql, {
                waitingPid: finalizerPid,
                holdingPid: revokerPid,
              });
            } finally {
              releaseRevoker.resolve(undefined);
            }
            await revocation;
            const outcome = await finalized;

            expect(Result.isError(outcome)).toBe(true);
            const stored = (
              await sessionScope(
                async (tx) =>
                  await tx
                    .select({
                      status: pdfSigningSessions.status,
                      finalizedVersionId: pdfSigningSessions.finalizedVersionId,
                    })
                    .from(pdfSigningSessions)
                    .where(eq(pdfSigningSessions.id, sessionId)),
              )
            ).at(0);
            expect(stored).toEqual({
              status: "open",
              finalizedVersionId: null,
            });
            expect(
              (
                await setup.db
                  .select({ currentVersionId: entities.currentVersionId })
                  .from(entities)
                  .where(eq(entities.id, entityId))
              ).at(0)?.currentVersionId,
            ).toBe(baseVersionId);
            return undefined;
          } finally {
            await setup.db
              .delete(organization)
              .where(eq(organization.id, organizationId));
            await setup.db.delete(user).where(eq(user.id, userId));
          }
        },
      );
    } finally {
      storage.stop();
      envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS =
        priorFileUsageFlag;
    }
  });
});
