import {
  jsonb,
  p,
  pUuid,
  safeUuid,
  safeWorkspaceId,
  sql,
  timestamptz,
  user,
  wsPolicies,
} from "./common";
import { workspaces } from "./contacts";
import { entities, entityVersions } from "./entities";
import { properties } from "./properties";

/**
 * One browser-to-desktop PDF signing exchange.
 *
 * `open`      the handoff was minted; the desktop may still redeem it, post a
 *             certificate and post a signature.
 * `finalized` a signed version was written; `finalized_version_id` names it.
 * `cancelled` the exchange ended without a version; `close_reason` says why.
 *
 * There is no scheduler sweep: liveness is `status = 'open' AND
 * token_expires_at > now()`, so an open row past its TTL is already dead and
 * the status endpoints report it as expired.
 */
export const PDF_SIGNING_SESSION_STATUSES = [
  "open",
  "finalized",
  "cancelled",
] as const;

export type PdfSigningSessionStatus =
  (typeof PDF_SIGNING_SESSION_STATUSES)[number];

/**
 * Why a cancelled exchange ended. Set only together with `cancelled`, so the
 * browser can say what happened rather than "signing failed".
 */
export const PDF_SIGNING_SESSION_CLOSE_REASONS = [
  "user_cancelled",
  "base_version_diverged",
  "digest_mismatch",
  "unsupported_platform",
  "certificate_rejected",
  "certificate_revoked",
  "certified_document",
  "signature_invalid",
  "signing_failed",
] as const;

export type PdfSigningSessionCloseReason =
  (typeof PDF_SIGNING_SESSION_CLOSE_REASONS)[number];

/** Signing key family, derived from the certificate's SPKI algorithm OID. */
export const PDF_SIGNING_KEY_TYPES = ["RSA", "EC"] as const;

export type PdfSigningKeyType = (typeof PDF_SIGNING_KEY_TYPES)[number];

const sqlValues = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

const PDF_SIGNING_SESSION_STATUS_SQL_VALUES = sqlValues(
  PDF_SIGNING_SESSION_STATUSES,
);
const PDF_SIGNING_SESSION_CLOSE_REASON_SQL_VALUES = sqlValues(
  PDF_SIGNING_SESSION_CLOSE_REASONS,
);
const PDF_SIGNING_KEY_TYPE_SQL_VALUES = sqlValues(PDF_SIGNING_KEY_TYPES);

/** Base64 DER of each intermediate the desktop keychain resolved. */
export type PdfSigningCertificateChain = string[];

export const pdfSigningSessions = p.pgTable(
  "pdf_signing_sessions",
  {
    id: pUuid<"pdfSigningSession">().primaryKey(),
    workspaceId: safeWorkspaceId("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityId: safeUuid<"entity">("entity_id").notNull(),
    propertyId: safeUuid<"property">("property_id").notNull(),
    baseVersionId: safeUuid<"entityVersion">("base_version_id")
      .notNull()
      .references(() => entityVersions.id, { onDelete: "cascade" }),
    finalizedVersionId: safeUuid<"entityVersion">("finalized_version_id"),
    createdBy: p
      .text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: p
      .text("status", { enum: PDF_SIGNING_SESSION_STATUSES })
      .notNull()
      .default("open"),
    closeReason: p.text("close_reason", {
      enum: PDF_SIGNING_SESSION_CLOSE_REASONS,
    }),
    handoffTokenHash: p.varchar("handoff_token_hash", { length: 64 }).notNull(),
    handoffExpiresAt: timestamptz("handoff_expires_at").notNull(),
    handoffConsumedAt: timestamptz("handoff_consumed_at"),
    sessionTokenHash: p.varchar("session_token_hash", { length: 64 }),
    tokenExpiresAt: timestamptz("token_expires_at").notNull(),
    reason: p.text("reason"),
    location: p.text("location"),
    signerCertificateDer: p.bytea("signer_certificate_der"),
    signerCertificateChain: jsonb(
      "signer_certificate_chain",
    ).$type<PdfSigningCertificateChain | null>(),
    signingTime: timestamptz("signing_time"),
    digestHex: p.varchar("digest_hex", { length: 64 }),
    /**
     * The DER CMS signed attributes `digest_hex` hashes. Kept so the
     * desktop's signature can be verified before anything is embedded.
     */
    signedAttributes: p.bytea("signed_attributes"),
    /**
     * Bytes reserved for the signature in phase 1. Part of the hashed byte
     * range, so phase 2 must reuse it rather than recompute it.
     */
    placeholderSize: p.integer("placeholder_size"),
    /**
     * The desktop's verified signature. Kept so a finalization that failed
     * for a transient reason can be retried without asking for a new PIN,
     * and so a retry can only ever embed this same signature.
     */
    signature: p.bytea("signature"),
    /** Finalizations started; bounded so a failing one cannot loop. */
    finalizeAttempts: p.integer("finalize_attempts").notNull().default(0),
    /**
     * Set while a finalization runs, so a retry that races a slow attempt
     * waits instead of embedding twice. Past it, the attempt is presumed
     * dead and the next one may start.
     */
    finalizeLeaseExpiresAt: timestamptz("finalize_lease_expires_at"),
    keyType: p.text("key_type", { enum: PDF_SIGNING_KEY_TYPES }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    closedAt: timestamptz("closed_at"),
  },
  (table) => [
    p.index("pdf_signing_sessions_workspace_id_idx").on(table.workspaceId),
    p.index("pdf_signing_sessions_entity_id_idx").on(table.entityId),
    p
      .uniqueIndex("pdf_signing_sessions_handoff_token_hash_uidx")
      .on(table.handoffTokenHash),
    p
      .uniqueIndex("pdf_signing_sessions_session_token_hash_uidx")
      .on(table.sessionTokenHash)
      .where(sql`${table.sessionTokenHash} IS NOT NULL`),
    // One live exchange per person per file field: a second "Sign" click on a
    // file already being signed is refused rather than silently forked.
    p
      .uniqueIndex("pdf_signing_sessions_open_uidx")
      .on(table.createdBy, table.entityId, table.propertyId)
      .where(sql`${table.status} = 'open'`),
    p.check(
      "pdf_signing_sessions_status_check",
      sql`${table.status} in (${PDF_SIGNING_SESSION_STATUS_SQL_VALUES})`,
    ),
    p.check(
      "pdf_signing_sessions_close_reason_check",
      sql`${table.closeReason} is null or ${table.closeReason} in (${PDF_SIGNING_SESSION_CLOSE_REASON_SQL_VALUES})`,
    ),
    p.check(
      "pdf_signing_sessions_finalize_attempts_check",
      sql`${table.finalizeAttempts} >= 0`,
    ),
    p.check(
      "pdf_signing_sessions_key_type_check",
      sql`${table.keyType} is null or ${table.keyType} in (${PDF_SIGNING_KEY_TYPE_SQL_VALUES})`,
    ),
    p
      .foreignKey({
        columns: [table.entityId, table.workspaceId],
        foreignColumns: [entities.id, entities.workspaceId],
        name: "pdf_signing_sessions_entity_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.propertyId, table.workspaceId],
        foreignColumns: [properties.id, properties.workspaceId],
        name: "pdf_signing_sessions_property_workspace_fk",
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        columns: [table.finalizedVersionId],
        foreignColumns: [entityVersions.id],
        name: "pdf_signing_sessions_finalized_version_fk",
      })
      .onDelete("set null"),
    ...wsPolicies(),
  ],
);
