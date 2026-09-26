/**
 * Lifecycle of a PDF signing exchange: minting the handoff, redeeming it
 * exactly once, and authorizing every later call from the session token.
 *
 * Both tokens are opaque and stored only as SHA-256 hex, so a lookup by hash
 * is the constant-time comparison. The handoff is single-use: redemption
 * locks its row and consumes it in one transaction, so two desktops racing
 * the same deep link cannot both win.
 */

import { and, eq, lte } from "drizzle-orm";

import { Temporal } from "@stll/time";

import { member } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
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
  PdfSigningStamp,
} from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createOpaqueToken,
  hashOpaqueToken,
  isOpaqueTokenShape,
} from "@/api/lib/entities/opaque-tokens";
import { canWriteWorkspaceEntities } from "@/api/lib/entities/workspace-entity-write-access";
import { createRootSafeDb } from "@/api/lib/root-scoped-db";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

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

export type OpenedPdfSigningSession =
  | { status: "created" }
  | { status: "in-progress" }
  | { status: "version-changed" };

/**
 * Open a new exchange for one person's file field.
 *
 * Only one may be open at a time (`pdf_signing_sessions_open_uidx`), and an
 * exchange past its TTL is dead but still stored as open: nothing sweeps it.
 * So the dead ones are closed first, in the same transaction (the UPDATE
 * locks them), and the insert yields to a live one instead of failing on
 * the index. Two racing requests end with one exchange and one
 * `in-progress`.
 */
export const openPdfSigningSession = async ({
  now,
  recordAuditEvent,
  tx,
  values,
}: {
  now: Date;
  recordAuditEvent: AuditRecorder;
  tx: Transaction;
  values: typeof pdfSigningSessions.$inferInsert;
}): Promise<OpenedPdfSigningSession> => {
  // The exchange is opened on the version the stamp and certification were
  // checked against, and only while it is still current. The share lock
  // holds a concurrent version write off until this transaction ends.
  const current = await tx
    .select({ currentVersionId: entities.currentVersionId })
    .from(entities)
    .where(
      and(
        eq(entities.id, values.entityId),
        eq(entities.workspaceId, values.workspaceId),
      ),
    )
    .limit(1)
    .for("share");
  if (current.at(0)?.currentVersionId !== values.baseVersionId) {
    return { status: "version-changed" };
  }

  const expired = await tx
    .update(pdfSigningSessions)
    .set({ closeReason: "expired", closedAt: now, status: "cancelled" })
    .where(
      and(
        eq(pdfSigningSessions.createdBy, values.createdBy),
        eq(pdfSigningSessions.entityId, values.entityId),
        eq(pdfSigningSessions.propertyId, values.propertyId),
        eq(pdfSigningSessions.status, "open"),
        // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- cutoff read from the caller's clock, never round-tripped through the database
        lte(pdfSigningSessions.tokenExpiresAt, now),
      ),
    )
    .returning({ id: pdfSigningSessions.id });
  await recordAuditEvent(
    tx,
    expired.map(({ id }) => ({
      action: AUDIT_ACTION.UPDATE,
      resourceType: AUDIT_RESOURCE_TYPE.PDF_SIGNING_SESSION,
      resourceId: id,
      changes: { status: { old: "open", new: "cancelled" } },
      metadata: { closeReason: "expired" },
    })),
  );

  const inserted = await tx
    .insert(pdfSigningSessions)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: pdfSigningSessions.id });

  return inserted.at(0) ? { status: "created" } : { status: "in-progress" };
};

export type RedeemedPdfSigningSession = {
  documentName: string;
  /** 1-based page of the visible stamp, `null` for an invisible signature. */
  stampPageNumber: number | null;
  expiresAt: Date;
  sessionId: SafeId<"pdfSigningSession">;
  sessionToken: string;
  versionNumber: number;
  workspaceName: string;
};

/**
 * The creator's live access, read with `FOR SHARE` so a revocation of the
 * `member` or `workspace_members` row waits for the redemption holding the
 * lock to commit, and a revocation that committed first is seen.
 */
export const lockedCreatorAccess = (
  tx: Pick<Transaction, "select">,
  {
    createdBy,
    organizationId,
    workspaceId,
  }: {
    createdBy: string;
    organizationId: SafeId<"organization">;
    workspaceId: SafeId<"workspace">;
  },
) => ({
  membership: tx
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, createdBy),
        eq(workspaceMembers.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .for("share"),
  role: tx
    .select({ role: member.role })
    .from(member)
    .where(
      and(
        eq(member.userId, createdBy),
        eq(member.organizationId, organizationId),
      ),
    )
    .limit(1)
    .for("share"),
});

/**
 * Redeem a handoff: check the creator's access, consume the handoff, mint
 * the session token and read the descriptor, all in one transaction.
 *
 * The session row is locked first, then the creator's access rows (see
 * {@link lockedCreatorAccess}), so a redemption and a revocation are
 * ordered: either the revocation lands first and the handoff is refused, or
 * the redemption commits first and the revocation closes the session at its
 * next use. `afterConsume` runs just before commit; a throw there undoes
 * the whole redemption (tests use it to prove that).
 */
export const redeemPdfSigningHandoff = async (
  handoffToken: string,
  db: PdfSigningDatabase,
  { afterConsume }: { afterConsume?: () => Promise<void> } = {},
): Promise<RedeemedPdfSigningSession | null> => {
  if (!isPdfSigningTokenShape(handoffToken)) {
    return null;
  }

  const now = new Date();
  const sessionToken = createPdfSigningToken();
  const expiresAt = computePdfSigningSessionExpiresAt();

  return await db.transaction(async (tx) => {
    const sessions = await tx
      .select({
        baseVersionId: pdfSigningSessions.baseVersionId,
        createdBy: pdfSigningSessions.createdBy,
        entityId: pdfSigningSessions.entityId,
        handoffConsumedAt: pdfSigningSessions.handoffConsumedAt,
        handoffExpiresAt: pdfSigningSessions.handoffExpiresAt,
        id: pdfSigningSessions.id,
        organizationId: workspaces.organizationId,
        stamp: pdfSigningSessions.stamp,
        status: pdfSigningSessions.status,
        workspaceId: pdfSigningSessions.workspaceId,
      })
      .from(pdfSigningSessions)
      .innerJoin(workspaces, eq(pdfSigningSessions.workspaceId, workspaces.id))
      .where(
        eq(
          pdfSigningSessions.handoffTokenHash,
          hashPdfSigningToken(handoffToken),
        ),
      )
      .limit(1)
      .for("update", { of: pdfSigningSessions });
    const session = sessions.at(0);
    if (
      !session ||
      session.status !== "open" ||
      session.handoffConsumedAt !== null ||
      session.handoffExpiresAt <= now
    ) {
      return null;
    }

    const access = lockedCreatorAccess(tx, session);
    const [roles, memberships] = await Promise.all([
      access.role,
      access.membership,
    ]);
    if (
      !canWriteWorkspaceEntities({
        organizationRole: roles.at(0)?.role ?? null,
        workspaceMemberId: memberships.at(0)?.id ?? null,
      })
    ) {
      return null;
    }

    const descriptors = await tx
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
      // Nothing to show the desktop: read before anything is written, so
      // the handoff stays unspent.
      return null;
    }

    await tx
      .update(pdfSigningSessions)
      .set({
        handoffConsumedAt: now,
        sessionTokenHash: hashPdfSigningToken(sessionToken),
        tokenExpiresAt: expiresAt,
      })
      .where(eq(pdfSigningSessions.id, session.id));

    await afterConsume?.();

    return {
      documentName: descriptor.documentName,
      expiresAt,
      sessionId: session.id,
      sessionToken,
      stampPageNumber:
        session.stamp === null ? null : session.stamp.pageIndex + 1,
      versionNumber: descriptor.versionNumber,
      workspaceName: descriptor.workspaceName,
    };
  });
};

export type AuthorizedPdfSigningSession = {
  baseVersionId: SafeId<"entityVersion">;
  digestHex: string | null;
  entityId: SafeId<"entity">;
  keyType: PdfSigningKeyType | null;
  location: string | null;
  organizationId: SafeId<"organization">;
  placeholderSize: number | null;
  propertyId: SafeId<"property">;
  reason: string | null;
  safeDb: SafeDb;
  sessionId: SafeId<"pdfSigningSession">;
  signature: Uint8Array | null;
  signedAttributes: Uint8Array | null;
  signerCertificateChain: string[] | null;
  signerCertificateDer: Uint8Array | null;
  signingTime: Date | null;
  stamp: PdfSigningStamp | null;
  userId: SafeId<"user">;
  workspaceId: SafeId<"workspace">;
};

export type PdfSigningSessionAuthorization =
  | { status: "authorized"; value: AuthorizedPdfSigningSession }
  | {
      status: "finalized";
      versionId: SafeId<"entityVersion">;
      versionNumber: number;
    }
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
  db: PdfSigningDatabase,
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
      finalizedVersionId: pdfSigningSessions.finalizedVersionId,
      finalizedVersionNumber: entityVersions.versionNumber,
      keyType: pdfSigningSessions.keyType,
      location: pdfSigningSessions.location,
      organizationId: workspaces.organizationId,
      organizationRole: member.role,
      placeholderSize: pdfSigningSessions.placeholderSize,
      propertyId: pdfSigningSessions.propertyId,
      reason: pdfSigningSessions.reason,
      sessionStatus: pdfSigningSessions.status,
      sessionTokenHash: pdfSigningSessions.sessionTokenHash,
      signature: pdfSigningSessions.signature,
      signedAttributes: pdfSigningSessions.signedAttributes,
      signerCertificateChain: pdfSigningSessions.signerCertificateChain,
      signerCertificateDer: pdfSigningSessions.signerCertificateDer,
      signingTime: pdfSigningSessions.signingTime,
      stamp: pdfSigningSessions.stamp,
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
      entityVersions,
      eq(entityVersions.id, pdfSigningSessions.finalizedVersionId),
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
    session.sessionTokenHash === null ||
    session.sessionTokenHash !== hashPdfSigningToken(sessionToken)
  ) {
    return { status: "missing" };
  }

  // The holder of the token may learn how its own exchange ended: a desktop
  // whose finalize response was lost retries and gets the version it made.
  if (
    session.sessionStatus === "finalized" &&
    session.finalizedVersionId !== null &&
    session.finalizedVersionNumber !== null
  ) {
    return {
      status: "finalized",
      versionId: session.finalizedVersionId,
      versionNumber: session.finalizedVersionNumber,
    };
  }
  if (session.sessionStatus !== "open") {
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
      placeholderSize: session.placeholderSize,
      propertyId: session.propertyId,
      reason: session.reason,
      safeDb: createRootSafeDb({
        organizationId: session.organizationId,
        userId,
        workspaceIds: [session.workspaceId],
      }),
      sessionId,
      signature: session.signature,
      signedAttributes: session.signedAttributes,
      signerCertificateChain: session.signerCertificateChain,
      signerCertificateDer: session.signerCertificateDer,
      signingTime: session.signingTime,
      stamp: session.stamp,
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

/**
 * The desktop's token-bearing calls carry no user session, so the session a
 * token names is found on the owner connection; everything after that runs
 * scoped to the session's creator (see `safeDb` above).
 */
export const redeemPdfSigningHandoffAsOwner = async (handoffToken: string) =>
  await redeemPdfSigningHandoff(handoffToken, rootDb);

export const authorizePdfSigningSessionAsOwner = async (credentials: {
  sessionId: SafeId<"pdfSigningSession">;
  sessionToken: string;
}) => await authorizePdfSigningSession(credentials, rootDb);
