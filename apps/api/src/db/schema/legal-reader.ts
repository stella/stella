import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

import {
  READER_ANNOTATION_BODY_MAX_LENGTH,
  READER_ANNOTATION_COLORS,
  READER_ANNOTATION_KINDS,
  READER_ANNOTATION_QUOTE_MAX_LENGTH,
  READER_ANNOTATION_STYLES,
  READER_ANNOTATION_TARGET_TYPES,
  READER_ANNOTATION_VISIBILITIES,
} from "@stll/api-contract/legal-reader-annotations";

import { reviewResetOwnerPolicies } from "../review-reset-policies";
import {
  SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID,
  SETTING_ACCOUNT_EXPORT_USER_ID,
} from "../rls";
import {
  authoredOptionalMatterNotePolicies,
  isNotNull,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  safeWorkspaceId,
  sql,
  timestamptz,
  user,
} from "./common";
import { workspaces } from "./contacts";

const sqlValues = (values: readonly string[]) =>
  values.map((value) => sql.raw(`'${value}'`));

const READER_ANNOTATION_TARGET_TYPE_SQL_VALUES = sqlValues(
  READER_ANNOTATION_TARGET_TYPES,
);
const READER_ANNOTATION_KIND_SQL_VALUES = sqlValues(READER_ANNOTATION_KINDS);
const READER_ANNOTATION_VISIBILITY_SQL_VALUES = sqlValues(
  READER_ANNOTATION_VISIBILITIES,
);
const READER_ANNOTATION_COLOR_SQL_VALUES = sqlValues(READER_ANNOTATION_COLORS);
const READER_ANNOTATION_STYLE_SQL_VALUES = sqlValues(READER_ANNOTATION_STYLES);

const LEGAL_READER_ANNOTATIONS = "legal_reader_annotations";

/** The table's owner: the role the claim-cleanup trigger runs as. */
const tableOwnerCheck = sql.raw(
  `current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.${LEGAL_READER_ANNOTATIONS}'::regclass)`,
);

/**
 * A claim's comment exists for the caller only while the claim does. The
 * database function (migration `20261021080000`) is SECURITY INVOKER, so the
 * claim's own policies (matter access, the verification's feature fence)
 * decide whether it finds the claim. The check lives in the database rather
 * than in this module: the public-law reader routes reach this table but
 * never a claim's comment, and are not part of the verification feature.
 */
type VerificationClaimColumns = {
  verificationClaimId: AnyPgColumn;
  verificationRunId: AnyPgColumn;
  workspaceId: AnyPgColumn;
};

const verificationClaimVisible = (t: VerificationClaimColumns) =>
  sql`public.legal_reader_annotation_claim_visible(${t.verificationClaimId}, ${t.verificationRunId}, ${t.workspaceId})`;

/**
 * The same test for a new comment, holding the claim `FOR KEY SHARE` until
 * the insert commits: a deletion of the claim then either waits for the
 * comment (and its cleanup trigger removes it) or has already removed the
 * claim, and the insert is refused. No comment can outlive its claim.
 */
const verificationClaimHeld = (t: VerificationClaimColumns) =>
  sql`public.legal_reader_annotation_claim_held(${t.verificationClaimId}, ${t.verificationRunId}, ${t.workspaceId})`;

/**
 * A matter document's mark exists for the caller only while the file it was
 * placed on does: the file field (`targetId`), of a live version of the
 * document (`entityId`), in the mark's matter. The database function
 * (migration `20261026120000`) is SECURITY INVOKER, so the field's and the
 * version's own policies (matter access, the entity feature fence) decide,
 * and a withdrawn version hides the marks on its words with them.
 */
type MatterDocumentColumns = {
  entityId: AnyPgColumn;
  targetId: AnyPgColumn;
  workspaceId: AnyPgColumn;
};

const matterDocumentVisible = (t: MatterDocumentColumns) =>
  sql`public.legal_reader_annotation_document_visible(${t.targetId}, ${t.entityId}, ${t.workspaceId})`;

/**
 * The same test for a new mark, holding the field `FOR KEY SHARE` until the
 * insert commits, as the claim check does: the document's deletion then
 * waits for the mark, and its cleanup trigger removes it.
 */
const matterDocumentHeld = (t: MatterDocumentColumns) =>
  sql`public.legal_reader_annotation_document_held(${t.targetId}, ${t.entityId}, ${t.workspaceId})`;

type MatterRowColumns = VerificationClaimColumns &
  MatterDocumentColumns & { targetType: AnyPgColumn };

/** The matter row a note sits on, by the note's target. */
const matterRowCheck = ({
  claim,
  document,
  t,
}: {
  claim: SQL;
  document: SQL;
  t: MatterRowColumns;
}) =>
  sql`CASE ${t.targetType} WHEN 'verification-claim' THEN ${claim} WHEN 'matter-document' THEN ${document} ELSE false END`;

/**
 * A reader's highlights and comments on a legal document: a case-law decision
 * or one consolidated statute version, told apart by `targetType`, or a
 * reviewer's comment on one claim of a matter's document verification.
 * Organization-owned, author-controlled: private by default, visible to the
 * organization once shared, and only ever edited by its author
 * (`authoredOptionalMatterNotePolicies`).
 *
 * The document is referenced by id without a foreign key: the public-law
 * corpus may live in another database (`PUBLIC_LAW_DATABASE_URL`), and a
 * document withdrawn from the corpus leaves its notes behind rather than
 * deleting a reader's own words. A statute's `targetId` is the consolidation
 * the reader had open, so the anchors always belong to the exact wording they
 * were placed on.
 *
 * The anchor is the block's stable anchor plus offsets into its rendered
 * text and the quoted text itself, so a re-parse that moves offsets can
 * still find the words.
 *
 * A claim's comment is matter content: it names the matter, the run and the
 * claim, and every policy admits it only while the caller can open the
 * matter and see that claim, so the matter's walls and the verification's
 * feature fence reach the notes on it, a shared one included. The claim is not a foreign key, because a key to a
 * fenced table enrols this table in the entity gate graph; a trigger on the
 * claims removes their comments instead, and the matter key cascades.
 *
 * A matter document's mark is matter content the same way: `targetId` is the
 * file field the reader had open, which belongs to one version of the
 * document (`entityId`), so its anchors belong to the exact bytes they were
 * placed on. Each row is one page of the PDF (`blockAnchorId` `page-<n>`),
 * with offsets into that page's extracted text and the text's digest, so a
 * new version, or the same page read differently, shows the mark as detached
 * rather than drawn over other words. The field and the document are not
 * foreign keys for the same reason as the claim; a trigger on the documents
 * removes their marks.
 */
export const legalReaderAnnotations = p.pgTable(
  LEGAL_READER_ANNOTATIONS,
  {
    id: pUuid<"legalReaderAnnotation">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    userId: p.text("user_id").notNull(),
    targetType: p
      .text("target_type", { enum: READER_ANNOTATION_TARGET_TYPES })
      .notNull(),
    targetId: p.uuid("target_id").notNull(),
    /** The matter a verification claim's comment belongs to; null on a
     * public-law document's mark. */
    workspaceId: safeWorkspaceId("workspace_id"),
    /** The verification run the commented claim belongs to. */
    verificationRunId: safeUuid<"legalListVerificationRun">(
      "verification_run_id",
    ),
    /** The commented claim; equal to `targetId` on a claim's comment. */
    verificationClaimId: safeUuid<"legalListClaim">("verification_claim_id"),
    /** The matter document a mark sits on; null on every other target. */
    entityId: safeUuid<"entity">("entity_id"),
    /**
     * SHA-256 (hex) of the marked page's extracted text when the mark was
     * made; another digest on the page read now means the offsets no longer
     * point at these words.
     */
    pageTextSha256: p.varchar("page_text_sha256", { length: 64 }),
    /**
     * Ties the rows of one mark that spans several paragraphs; null for a
     * mark inside one. A change to the mark reaches every row of the group.
     */
    groupId: p.uuid("group_id"),
    kind: p.text("kind", { enum: READER_ANNOTATION_KINDS }).notNull(),
    visibility: p
      .text("visibility", { enum: READER_ANNOTATION_VISIBILITIES })
      .notNull()
      .default("private"),
    color: p.text("color", { enum: READER_ANNOTATION_COLORS }),
    style: p.text("style", { enum: READER_ANNOTATION_STYLES }),
    blockAnchorId: p.varchar("block_anchor_id", { length: 64 }).notNull(),
    startOffset: p.integer("start_offset").notNull(),
    endOffset: p.integer("end_offset").notNull(),
    quote: p.varchar({ length: READER_ANNOTATION_QUOTE_MAX_LENGTH }).notNull(),
    body: p.varchar({ length: READER_ANNOTATION_BODY_MAX_LENGTH }),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    // A target id is a UUID, so it already names one document; the
    // discriminator is a filter on the rows it selects, not a way to narrow
    // them further.
    p
      .index(`${LEGAL_READER_ANNOTATIONS}_target_idx`)
      .on(t.organizationId, t.targetId, t.createdAt, t.id),
    p.check(
      `${LEGAL_READER_ANNOTATIONS}_target_type_values`,
      sql`${t.targetType} IN (${sql.join(READER_ANNOTATION_TARGET_TYPE_SQL_VALUES, sql`, `)})`,
    ),
    p
      .foreignKey({
        name: `${LEGAL_READER_ANNOTATIONS}_organization_id_fk`,
        columns: [t.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: `${LEGAL_READER_ANNOTATIONS}_user_id_fk`,
        columns: [t.userId],
        foreignColumns: [user.id],
      })
      .onDelete("cascade"),
    // A claim's comment carries its matter, run and claim; nothing else does.
    p.check(
      `${LEGAL_READER_ANNOTATIONS}_verification_claim_shape`,
      sql`(${t.targetType} = 'verification-claim') = (${t.workspaceId} IS NOT NULL AND ${t.verificationRunId} IS NOT NULL AND ${t.verificationClaimId} IS NOT NULL)
        AND (${t.verificationClaimId} IS NULL OR ${t.verificationClaimId} = ${t.targetId})`,
    ),
    // The matter is held to the comment's organization, and deleting it
    // deletes the comments on its claims.
    p
      .foreignKey({
        name: `${LEGAL_READER_ANNOTATIONS}_workspace_organization_fk`,
        columns: [t.workspaceId, t.organizationId],
        foreignColumns: [workspaces.id, workspaces.organizationId],
      })
      .onDelete("cascade"),
    // Serves the matter key's cascade and the claim trigger's cleanup.
    p
      .index(`${LEGAL_READER_ANNOTATIONS}_verification_claim_idx`)
      .on(t.workspaceId, t.verificationClaimId)
      .where(isNotNull(t.workspaceId)),
    // A matter document's mark carries its document, page and page digest;
    // nothing else does.
    p.check(
      `${LEGAL_READER_ANNOTATIONS}_matter_document_shape`,
      sql`(${t.targetType} = 'matter-document') = (${t.entityId} IS NOT NULL AND ${t.pageTextSha256} IS NOT NULL)
        AND (${t.targetType} <> 'matter-document' OR (${t.workspaceId} IS NOT NULL AND ${t.blockAnchorId} ~ '^page-[1-9][0-9]{0,5}$' AND ${t.pageTextSha256} ~ '^[0-9a-f]{64}$'))`,
    ),
    // Lists a document's marks oldest first, and serves the document cleanup
    // trigger.
    p
      .index(`${LEGAL_READER_ANNOTATIONS}_matter_document_idx`)
      .on(t.workspaceId, t.entityId, t.createdAt, t.id)
      .where(isNotNull(t.entityId)),
    p
      .index(`${LEGAL_READER_ANNOTATIONS}_group_idx`)
      .on(t.organizationId, t.groupId)
      .where(isNotNull(t.groupId)),
    p.check(
      `${LEGAL_READER_ANNOTATIONS}_kind_values`,
      sql`${t.kind} IN (${sql.join(READER_ANNOTATION_KIND_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      `${LEGAL_READER_ANNOTATIONS}_visibility_values`,
      sql`${t.visibility} IN (${sql.join(READER_ANNOTATION_VISIBILITY_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      `${LEGAL_READER_ANNOTATIONS}_color_values`,
      sql`${t.color} IS NULL OR ${t.color} IN (${sql.join(READER_ANNOTATION_COLOR_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      `${LEGAL_READER_ANNOTATIONS}_style_values`,
      sql`${t.style} IS NULL OR ${t.style} IN (${sql.join(READER_ANNOTATION_STYLE_SQL_VALUES, sql`, `)})`,
    ),
    // A highlight is a colour and a style on the text; a comment is words,
    // carried by its first row when the passage spans paragraphs.
    p.check(
      `${LEGAL_READER_ANNOTATIONS}_kind_shape`,
      sql`(${t.kind} = 'highlight' AND ${t.color} IS NOT NULL AND ${t.style} IS NOT NULL AND ${t.body} IS NULL)
        OR (${t.kind} = 'comment' AND ${t.style} IS NULL AND ((${t.body} IS NOT NULL AND ${t.body} <> '') OR ${t.groupId} IS NOT NULL))`,
    ),
    p.check(
      `${LEGAL_READER_ANNOTATIONS}_span_shape`,
      sql`${t.startOffset} >= 0 AND ${t.endOffset} > ${t.startOffset} AND ${t.quote} <> ''`,
    ),
    ...authoredOptionalMatterNotePolicies({
      matterRowCheck: matterRowCheck({
        claim: verificationClaimVisible(t),
        document: matterDocumentVisible(t),
        t,
      }),
      matterRowHold: matterRowCheck({
        claim: verificationClaimHeld(t),
        document: matterDocumentHeld(t),
        t,
      }),
    }),
    p.pgPolicy("account_export_owner_select", {
      for: "select",
      using: sql`${tableOwnerCheck}
        AND ${t.organizationId} = nullif(current_setting('${sql.raw(SETTING_ACCOUNT_EXPORT_ORGANIZATION_ID)}', true), '')
        AND ${t.userId} = nullif(current_setting('${sql.raw(SETTING_ACCOUNT_EXPORT_USER_ID)}', true), '')`,
    }),
    ...reviewResetOwnerPolicies(LEGAL_READER_ANNOTATIONS),
    // The claim-cleanup trigger runs as the owner and removes every author's
    // comments on the claims a statement deleted, only during trigger execution.
    p.pgPolicy("claim_cleanup_owner_select", {
      for: "select",
      using: sql`${tableOwnerCheck} AND pg_catalog.pg_trigger_depth() > 0 AND verification_claim_id IS NOT NULL`,
    }),
    p.pgPolicy("claim_cleanup_owner_delete", {
      for: "delete",
      using: sql`${tableOwnerCheck} AND pg_catalog.pg_trigger_depth() > 0 AND verification_claim_id IS NOT NULL`,
    }),
    // The document-cleanup trigger does the same for the marks on the
    // documents a statement deleted.
    p.pgPolicy("document_cleanup_owner_select", {
      for: "select",
      using: sql`${tableOwnerCheck} AND pg_catalog.pg_trigger_depth() > 0 AND entity_id IS NOT NULL`,
    }),
    p.pgPolicy("document_cleanup_owner_delete", {
      for: "delete",
      using: sql`${tableOwnerCheck} AND pg_catalog.pg_trigger_depth() > 0 AND entity_id IS NOT NULL`,
    }),
  ],
);
