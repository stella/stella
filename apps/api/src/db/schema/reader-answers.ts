import { READER_ANNOTATION_VISIBILITIES } from "@stll/api-contract/legal-reader-annotations";
import {
  READER_ANSWER_ERROR_CODES,
  READER_ANSWER_KINDS,
  READER_ANSWER_MESSAGE_ROLES,
  READER_ANSWER_MESSAGE_STATUSES,
  type ReaderAnswerCitation,
  type ReaderAnswerUsage,
} from "@stll/api-contract/reader-answers";

import { accountErasureOwnerPolicies } from "../account-erasure-policies";
import { reviewResetOwnerPolicies } from "../review-reset-policies";
import {
  authoredNotePolicies,
  jsonb,
  organization,
  p,
  pUuid,
  safeOrganizationId,
  safeUuid,
  sql,
  stella,
  timestamptz,
  user,
} from "./common";

const sqlValues = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql.raw(`'${value}'`)),
    sql`, `,
  );

/** Corpus IDs deliberately have no FK: the public corpus can live separately. */
export const legalReaderAnswers = p.pgTable(
  "legal_reader_answers",
  {
    id: pUuid<"legalReaderAnswer">().primaryKey(),
    organizationId: safeOrganizationId("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: p
      .text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    decisionId: safeUuid<"caseLawDecision">("decision_id").notNull(),
    kind: p.text("kind", { enum: READER_ANSWER_KINDS }).notNull(),
    visibility: p
      .text("visibility", { enum: READER_ANNOTATION_VISIBILITIES })
      .notNull()
      .default("private"),
    paragraphId: p.varchar("paragraph_id", { length: 64 }).notNull(),
    quote: p.text("quote").notNull(),
    startOffset: p.integer("start_offset").notNull(),
    endOffset: p.integer("end_offset").notNull(),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
    deletedAt: timestamptz("deleted_at"),
  },
  (t) => [
    p
      .index("legal_reader_answers_decision_idx")
      .on(t.organizationId, t.decisionId, t.createdAt, t.id),
    p.index("legal_reader_answers_user_idx").on(t.userId),
    p.check(
      "legal_reader_answers_kind_values",
      sql`${t.kind} IN (${sqlValues(READER_ANSWER_KINDS)})`,
    ),
    p.check(
      "legal_reader_answers_visibility_values",
      sql`${t.visibility} IN (${sqlValues(READER_ANNOTATION_VISIBILITIES)})`,
    ),
    p.check(
      "legal_reader_answers_span_shape",
      sql`${t.startOffset} >= 0 AND ${t.endOffset} > ${t.startOffset} AND ${t.quote} <> '' AND ${t.paragraphId} <> ''`,
    ),
    ...authoredNotePolicies(),
    // Account erasure removes private threads; shared threads remain organization data.
    ...accountErasureOwnerPolicies("legal_reader_answers"),
    // The review reset clears every author's threads; messages go by cascade.
    ...reviewResetOwnerPolicies("legal_reader_answers"),
  ],
);

const readableParent = sql`EXISTS (
  SELECT 1 FROM legal_reader_answers answer
  WHERE answer.id = legal_reader_answer_messages.answer_id
    AND answer.organization_id = (SELECT current_setting('app.organization_id', true))
    AND (answer.visibility = 'shared' OR answer.user_id = (SELECT current_setting('app.user_id', true)))
)`;
const writableParent = sql`EXISTS (
  SELECT 1 FROM legal_reader_answers answer
  WHERE answer.id = legal_reader_answer_messages.answer_id
    AND answer.organization_id = (SELECT current_setting('app.organization_id', true))
    AND answer.user_id = (SELECT current_setting('app.user_id', true))
)`;

/** Message access follows the parent's current author and sharing scope. */
export const legalReaderAnswerMessages = p.pgTable(
  "legal_reader_answer_messages",
  {
    id: pUuid<"legalReaderAnswerMessage">().primaryKey(),
    answerId: safeUuid<"legalReaderAnswer">("answer_id").notNull(),
    /** Stable conversational order assigned while the parent answer is locked. */
    sequence: p.integer("sequence").notNull(),
    role: p.text("role", { enum: READER_ANSWER_MESSAGE_ROLES }).notNull(),
    content: p.text("content").notNull(),
    citations: jsonb("citations")
      .$type<ReaderAnswerCitation[]>()
      .notNull()
      .default([]),
    model: p.text("model"),
    usage: jsonb("usage").$type<ReaderAnswerUsage>(),
    status: p
      .text("status", { enum: READER_ANSWER_MESSAGE_STATUSES })
      .notNull(),
    /** Stable failure code preserved when the reader reloads a message. */
    errorCode: p.text("error_code", { enum: READER_ANSWER_ERROR_CODES }),
    /** Number of generated citations withheld by validation. */
    invalidCitationCount: p
      .integer("invalid_citation_count")
      .notNull()
      .default(0),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    updatedAt: timestamptz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    p
      .foreignKey({
        name: "legal_reader_answer_messages_answer_fk",
        columns: [t.answerId],
        foreignColumns: [legalReaderAnswers.id],
      })
      .onDelete("cascade"),
    p
      .uniqueIndex("legal_reader_answer_messages_answer_sequence_idx")
      .on(t.answerId, t.sequence),
    p.check(
      "legal_reader_answer_messages_sequence_positive",
      sql`${t.sequence} > 0`,
    ),
    p.check(
      "legal_reader_answer_messages_role_values",
      sql`${t.role} IN (${sqlValues(READER_ANSWER_MESSAGE_ROLES)})`,
    ),
    p.check(
      "legal_reader_answer_messages_status_values",
      sql`${t.status} IN (${sqlValues(READER_ANSWER_MESSAGE_STATUSES)})`,
    ),
    p.check(
      "legal_reader_answer_messages_citations_array",
      sql`jsonb_typeof(${t.citations}) = 'array'`,
    ),
    p.check(
      "legal_reader_answer_messages_error_code_values",
      sql`${t.errorCode} IS NULL OR ${t.errorCode} IN (${sqlValues(READER_ANSWER_ERROR_CODES)})`,
    ),
    p.check(
      "legal_reader_answer_messages_invalid_citation_count_nonnegative",
      sql`${t.invalidCitationCount} >= 0`,
    ),
    p.pgPolicy("answer_select", {
      for: "select",
      to: stella,
      using: readableParent,
    }),
    p.pgPolicy("answer_insert", {
      for: "insert",
      to: stella,
      withCheck: writableParent,
    }),
    p.pgPolicy("answer_update", {
      for: "update",
      to: stella,
      using: writableParent,
      withCheck: writableParent,
    }),
    p.pgPolicy("answer_delete", {
      for: "delete",
      to: stella,
      using: writableParent,
    }),
  ],
);
