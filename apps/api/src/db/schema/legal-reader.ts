import {
  READER_ANNOTATION_BODY_MAX_LENGTH,
  READER_ANNOTATION_COLORS,
  READER_ANNOTATION_KINDS,
  READER_ANNOTATION_QUOTE_MAX_LENGTH,
  READER_ANNOTATION_STYLES,
  READER_ANNOTATION_TARGET_TYPES,
  READER_ANNOTATION_VISIBILITIES,
} from "@stll/api-contract/legal-reader-annotations";

import {
  authoredNotePolicies,
  isNotNull,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
} from "./common";
import type { AnyPgColumn } from "./common";

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

/**
 * What a reader's mark is, apart from the document it sits on: who left it,
 * what it looks like, which words it covers and what it says. Shared with
 * `caseLawDecisionAnnotations`, the table this one replaces, so the cutover
 * cannot leave the two shapes describing different things; both definitions
 * disappear into this one when the retiring table is dropped.
 */
export const readerAnnotationColumns = () => ({
  id: pUuid<"legalReaderAnnotation">().primaryKey(),
  organizationId: safeOrganizationId("organization_id").notNull(),
  userId: p.text("user_id").notNull(),
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
});

type ReaderAnnotationColumns = Record<
  | "blockAnchorId"
  | "body"
  | "color"
  | "endOffset"
  | "groupId"
  | "kind"
  | "organizationId"
  | "quote"
  | "startOffset"
  | "style"
  | "userId"
  | "visibility",
  AnyPgColumn
>;

/**
 * Everything a reader-annotation table constrains about a mark itself: who
 * owns it, the closed value sets, and the two shape rules. Named from the
 * table so the retiring table keeps the constraint names it was created
 * with, which is what the migrations spell.
 */
export const readerAnnotationConstraints = (
  table: string,
  t: ReaderAnnotationColumns,
) => [
  p
    .foreignKey({
      name: `${table}_organization_id_fk`,
      columns: [t.organizationId],
      foreignColumns: [organization.id],
    })
    .onDelete("cascade"),
  p
    .foreignKey({
      name: `${table}_user_id_fk`,
      columns: [t.userId],
      foreignColumns: [user.id],
    })
    .onDelete("cascade"),
  p
    .index(`${table}_group_idx`)
    .on(t.organizationId, t.groupId)
    .where(isNotNull(t.groupId)),
  p.check(
    `${table}_kind_values`,
    sql`${t.kind} IN (${sql.join(READER_ANNOTATION_KIND_SQL_VALUES, sql`, `)})`,
  ),
  p.check(
    `${table}_visibility_values`,
    sql`${t.visibility} IN (${sql.join(READER_ANNOTATION_VISIBILITY_SQL_VALUES, sql`, `)})`,
  ),
  p.check(
    `${table}_color_values`,
    sql`${t.color} IS NULL OR ${t.color} IN (${sql.join(READER_ANNOTATION_COLOR_SQL_VALUES, sql`, `)})`,
  ),
  p.check(
    `${table}_style_values`,
    sql`${t.style} IS NULL OR ${t.style} IN (${sql.join(READER_ANNOTATION_STYLE_SQL_VALUES, sql`, `)})`,
  ),
  // A highlight is a colour and a style on the text; a comment is words,
  // carried by its first row when the passage spans paragraphs.
  p.check(
    `${table}_kind_shape`,
    sql`(${t.kind} = 'highlight' AND ${t.color} IS NOT NULL AND ${t.style} IS NOT NULL AND ${t.body} IS NULL)
        OR (${t.kind} = 'comment' AND ${t.style} IS NULL AND ((${t.body} IS NOT NULL AND ${t.body} <> '') OR ${t.groupId} IS NOT NULL))`,
  ),
  p.check(
    `${table}_span_shape`,
    sql`${t.startOffset} >= 0 AND ${t.endOffset} > ${t.startOffset} AND ${t.quote} <> ''`,
  ),
  ...authoredNotePolicies(),
];

const LEGAL_READER_ANNOTATIONS = "legal_reader_annotations";

/**
 * A reader's highlights and comments on a legal document: a case-law decision
 * or one consolidated statute version, told apart by `targetType`.
 * Organization-owned, author-controlled: private by default, visible to the
 * organization once shared, and only ever edited by its author
 * (`authoredNotePolicies`).
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
 */
export const legalReaderAnnotations = p.pgTable(
  LEGAL_READER_ANNOTATIONS,
  {
    ...readerAnnotationColumns(),
    targetType: p
      .text("target_type", { enum: READER_ANNOTATION_TARGET_TYPES })
      .notNull(),
    targetId: p.uuid("target_id").notNull(),
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
    ...readerAnnotationConstraints(LEGAL_READER_ANNOTATIONS, t),
  ],
);
