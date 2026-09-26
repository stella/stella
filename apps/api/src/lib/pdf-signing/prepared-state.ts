/**
 * Phase 1's result, stored once.
 *
 * The digest phase 1 returns is what the desktop's keychain signs, so it
 * must never change under it. The first preparation wins: the UPDATE only
 * lands on an exchange nothing has prepared yet, and a concurrent second
 * one reads back what the first stored instead of replacing it.
 */

import { and, eq, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { pdfSigningSessions } from "@/api/db/schema";
import type { PdfSigningKeyType } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type PreparedStateValues = {
  digestHex: string;
  keyType: PdfSigningKeyType;
  placeholderSize: number;
  signedAttributes: Uint8Array;
  signerCertificateChain: string[];
  signerCertificateDer: Uint8Array;
  signingTime: Date;
};

export type StoredPreparedState =
  | { status: "stored" }
  /** Another preparation won; it is for this same certificate. */
  | { status: "already-prepared"; digestHex: string }
  /** Another preparation won for a different certificate. */
  | { status: "conflict" }
  | { status: "closed" };

export const storePreparedState = async ({
  sessionId,
  tx,
  values,
}: {
  sessionId: SafeId<"pdfSigningSession">;
  tx: Pick<Transaction, "select" | "update">;
  values: PreparedStateValues;
}): Promise<StoredPreparedState> => {
  // audit: skip — the certificate and digest are the prepared state of an
  // already-audited exchange, not a state transition. The CREATE is
  // recorded when the exchange opens and the UPDATE when it closes.
  const stored = await tx
    .update(pdfSigningSessions)
    .set({
      ...values,
      signedAttributes: Buffer.from(values.signedAttributes),
      signerCertificateDer: Buffer.from(values.signerCertificateDer),
    })
    .where(
      and(
        eq(pdfSigningSessions.id, sessionId),
        eq(pdfSigningSessions.status, "open"),
        isNull(pdfSigningSessions.digestHex),
      ),
    )
    .returning({ id: pdfSigningSessions.id });
  if (stored.at(0)) {
    return { status: "stored" };
  }

  const rows = await tx
    .select({
      digestHex: pdfSigningSessions.digestHex,
      signerCertificateDer: pdfSigningSessions.signerCertificateDer,
      status: pdfSigningSessions.status,
    })
    .from(pdfSigningSessions)
    .where(eq(pdfSigningSessions.id, sessionId))
    .limit(1);
  const row = rows.at(0);
  if (row?.status !== "open" || row.digestHex === null) {
    return { status: "closed" };
  }
  return row.signerCertificateDer !== null &&
    Buffer.from(row.signerCertificateDer).equals(
      Buffer.from(values.signerCertificateDer),
    )
    ? { status: "already-prepared", digestHex: row.digestHex }
    : { status: "conflict" };
};
