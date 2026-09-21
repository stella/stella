/**
 * Lifecycle of a PDF signing exchange: minting the handoff, redeeming it
 * exactly once, and authorizing every later call from the session token.
 *
 * Both tokens are opaque and stored only as SHA-256 hex, so a lookup by hash
 * is the constant-time comparison. The handoff is single-use: redemption is
 * one conditional UPDATE that both consumes it and installs the session
 * token, so two desktops racing the same deep link cannot both win.
 */

import { and, eq, gt, isNull } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { member } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  pdfSigningSessions,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import type {
  PdfSigningKeyType,
  PdfSigningSessionCloseReason,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createOpaqueToken,
  hashOpaqueToken,
  isOpaqueTokenShape,
} from "@/api/lib/opaque-tokens";
import { createRootSafeDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import { canWriteWorkspaceEntities } from "@/api/lib/workspace-entity-write-access";

/** The browser hands the deep link straight to the OS; two minutes is the
 *  whole window in which the desktop app has to come up and redeem it. */
const PDF_SIGNING_HANDOFF_TTL_MS = 2 * 60 * 1000;

/** The desktop dialog is modal: pick an identity, sign, done. */
const PDF_SIGNING_SESSION_TTL_MS = 10 * 60 * 1000;

const expiryFromNow = (ttlMs: number) =>
  new Date(Temporal.Now.instant().epochMilliseconds + ttlMs);

export const computePdfSigningHandoffExpiresAt = () =>
  expiryFromNow(PDF_SIGNING_HANDOFF_TTL_MS);

const computePdfSigningSessionExpiresAt = () =>
  expiryFromNow(PDF_SIGNING_SESSION_TTL_MS);

export const createPdfSigningToken = createOpaqueToken;

export const hashPdfSigningToken = hashOpaqueToken;

const isPdfSigningTokenShape = isOpaqueTokenShape;

/**
 * The owner-level handle these two functions run on. Redemption and
 * authorization both act before any workspace scope exists (the caller is a
 * desktop app holding only a token), so they cannot use `scopedDb`; the
 * `WHERE` clauses carry the whole access decision. Injectable so an
 * integration test can drive the real statements against a test database.
 */
type PdfSigningDatabase = typeof rootDb;

export type RedeemedPdfSigningSession = {
  documentName: string;
  expiresAt: Date;
  sessionId: SafeId<"pdfSigningSession">;
  sessionToken: string;
  versionNumber: number;
  workspaceName: string;
};

/**
 * Consume a handoff token and mint the session token in the same statement.
 *
 * `handoff_consumed_at IS NULL` plus the TTL are part of the UPDATE's WHERE,
 * so the row itself arbitrates the race: the loser updates zero rows and gets
 * the same answer as an unknown token.
 */
export const redeemPdfSigningHandoff = async (
  handoffToken: string,
  db: PdfSigningDatabase = rootDb,
): Promise<RedeemedPdfSigningSession | null> => {
  if (!isPdfSigningTokenShape(handoffToken)) {
    return null;
  }

  const now = new Date();
  const sessionToken = createPdfSigningToken();
  const expiresAt = computePdfSigningSessionExpiresAt();

  const redeemed = await db
    .update(pdfSigningSessions)
    .set({
      handoffConsumedAt: now,
      sessionTokenHash: hashPdfSigningToken(sessionToken),
      tokenExpiresAt: expiresAt,
    })
    .where(
      and(
        eq(
          pdfSigningSessions.handoffTokenHash,
          hashPdfSigningToken(handoffToken),
        ),
        eq(pdfSigningSessions.status, "open"),
        isNull(pdfSigningSessions.handoffConsumedAt),
        gt(pdfSigningSessions.handoffExpiresAt, now),
      ),
    )
    .returning({
      baseVersionId: pdfSigningSessions.baseVersionId,
      entityId: pdfSigningSessions.entityId,
      id: pdfSigningSessions.id,
      workspaceId: pdfSigningSessions.workspaceId,
    });

  const session = redeemed.at(0);
  if (!session) {
    return null;
  }

  const descriptors = await db
    .select({
      documentName: entities.name,
      versionNumber: entityVersions.versionNumber,
      workspaceName: workspaces.name,
    })
    .from(entities)
    .innerJoin(workspaces, eq(workspaces.id, entities.workspaceId))
    .innerJoin(entityVersions, eq(entityVersions.id, session.baseVersionId))
    .where(
      and(
        eq(entities.id, session.entityId),
        eq(entities.workspaceId, session.workspaceId),
      ),
    )
    .limit(1);

  const descriptor = descriptors.at(0);
  if (!descriptor) {
    return null;
  }

  return {
    documentName: descriptor.documentName,
    expiresAt,
    sessionId: session.id,
    sessionToken,
    versionNumber: descriptor.versionNumber,
    workspaceName: descriptor.workspaceName,
  };
};

export type AuthorizedPdfSigningSession = {
  baseVersionId: SafeId<"entityVersion">;
  digestHex: string | null;
  entityId: SafeId<"entity">;
  keyType: PdfSigningKeyType | null;
  location: string | null;
  organizationId: SafeId<"organization">;
  propertyId: SafeId<"property">;
  reason: string | null;
  safeDb: SafeDb;
  sessionId: SafeId<"pdfSigningSession">;
  signerCertificateChain: string[] | null;
  signerCertificateDer: Uint8Array | null;
  signingTime: Date | null;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export type PdfSigningSessionAuthorization =
  | { status: "authorized"; value: AuthorizedPdfSigningSession }
  | { status: "missing" }
  | { status: "token-expired" }
  | { status: "permission-revoked" };

/**
 * Authorize one token-bearing call.
 *
 * A malformed token, an unknown session, a closed session and a token
 * mismatch all answer `missing`: the caller turns every one of them into the
 * same 404, so probing cannot tell an existing session from an invented one.
 * The creator's `entity:update` permission is re-read from the live rows on
 * every call, not trusted from mint time.
 */
export const authorizePdfSigningSession = async (
  {
    sessionId,
    sessionToken,
  }: {
    sessionId: SafeId<"pdfSigningSession">;
    sessionToken: string;
  },
  db: PdfSigningDatabase = rootDb,
): Promise<PdfSigningSessionAuthorization> => {
  if (!isPdfSigningTokenShape(sessionToken)) {
    return { status: "missing" };
  }

  const rows = await db
    .select({
      baseVersionId: pdfSigningSessions.baseVersionId,
      createdBy: pdfSigningSessions.createdBy,
      digestHex: pdfSigningSessions.digestHex,
      entityId: pdfSigningSessions.entityId,
      keyType: pdfSigningSessions.keyType,
      location: pdfSigningSessions.location,
      organizationId: workspaces.organizationId,
      organizationRole: member.role,
      propertyId: pdfSigningSessions.propertyId,
      reason: pdfSigningSessions.reason,
      sessionStatus: pdfSigningSessions.status,
      sessionTokenHash: pdfSigningSessions.sessionTokenHash,
      signerCertificateChain: pdfSigningSessions.signerCertificateChain,
      signerCertificateDer: pdfSigningSessions.signerCertificateDer,
      signingTime: pdfSigningSessions.signingTime,
      tokenExpiresAt: pdfSigningSessions.tokenExpiresAt,
      workspaceId: pdfSigningSessions.workspaceId,
      workspaceMemberId: workspaceMembers.id,
    })
    .from(pdfSigningSessions)
    .innerJoin(workspaces, eq(pdfSigningSessions.workspaceId, workspaces.id))
    .leftJoin(
      member,
      and(
        eq(member.userId, pdfSigningSessions.createdBy),
        eq(member.organizationId, workspaces.organizationId),
      ),
    )
    .leftJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.userId, pdfSigningSessions.createdBy),
        eq(workspaceMembers.workspaceId, pdfSigningSessions.workspaceId),
      ),
    )
    .where(eq(pdfSigningSessions.id, sessionId))
    .limit(1);

  const session = rows.at(0);
  if (
    !session ||
    session.sessionStatus !== "open" ||
    session.sessionTokenHash === null ||
    session.sessionTokenHash !== hashPdfSigningToken(sessionToken)
  ) {
    return { status: "missing" };
  }

  if (session.tokenExpiresAt < new Date()) {
    return { status: "token-expired" };
  }

  if (
    !canWriteWorkspaceEntities({
      organizationRole: session.organizationRole,
      workspaceMemberId: session.workspaceMemberId,
    })
  ) {
    return { status: "permission-revoked" };
  }

  const userId = brandPersistedUserId(session.createdBy);

  return {
    status: "authorized",
    value: {
      baseVersionId: session.baseVersionId,
      digestHex: session.digestHex,
      entityId: session.entityId,
      keyType: session.keyType,
      location: session.location,
      organizationId: session.organizationId,
      propertyId: session.propertyId,
      reason: session.reason,
      safeDb: createRootSafeDb({
        organizationId: session.organizationId,
        userId,
        workspaceIds: [session.workspaceId],
      }),
      sessionId,
      signerCertificateChain: session.signerCertificateChain,
      signerCertificateDer: session.signerCertificateDer,
      signingTime: session.signingTime,
      userId,
      workspaceId: session.workspaceId,
    },
  };
};

export type PdfSigningSessionView = {
  closeReason: PdfSigningSessionCloseReason | null;
  expiresAt: string;
  finalizedVersionId: SafeId<"entityVersion"> | null;
  finalizedVersionNumber: number | null;
  status: "open" | "finalized" | "cancelled" | "expired";
};

type ResolvePdfSigningSessionStatusOptions = {
  closeReason: PdfSigningSessionCloseReason | null;
  finalizedVersionId: SafeId<"entityVersion"> | null;
  finalizedVersionNumber: number | null;
  now: Date;
  status: "open" | "finalized" | "cancelled";
  tokenExpiresAt: Date;
};

/**
 * The status the browser sees. `expired` is derived, never stored: an open
 * row past its TTL is dead, and no sweep rewrites it.
 */
export const resolvePdfSigningSessionStatus = ({
  closeReason,
  finalizedVersionId,
  finalizedVersionNumber,
  now,
  status,
  tokenExpiresAt,
}: ResolvePdfSigningSessionStatusOptions): PdfSigningSessionView => ({
  closeReason,
  expiresAt: tokenExpiresAt.toISOString(),
  finalizedVersionId,
  finalizedVersionNumber,
  status: status === "open" && tokenExpiresAt <= now ? "expired" : status,
});
