import {
  organization,
  p,
  pUuid,
  safeOrganizationId,
  sql,
  timestamptz,
  user,
  userOrganizationPolicies,
} from "./common";

/**
 * Which side of one comparison a row stands for: the DOCX the caller stages
 * for the comparison, or the redline the comparison produced. The two differ
 * in who writes the object and in what is known about its bytes up front, so
 * they are one kind column rather than two tables that would duplicate the
 * lifecycle, the sweep, and the teardown census.
 */
export const FILE_COMPARISON_UPLOAD_KINDS = ["input", "redline"] as const;

export type FileComparisonUploadKind =
  (typeof FILE_COMPARISON_UPLOAD_KINDS)[number];

/**
 * `pending`  the presigned URL was issued, the bytes may not be there yet.
 * `ready`    the object exists and matches what the row declared.
 * `consumed` the comparison read it; the object is being deleted.
 * `failed`   verification or the security scan refused the bytes.
 */
export const FILE_COMPARISON_UPLOAD_STATUSES = [
  "pending",
  "ready",
  "consumed",
  "failed",
] as const;

export type FileComparisonUploadStatus =
  (typeof FILE_COMPARISON_UPLOAD_STATUSES)[number];

const KIND_SQL_VALUES = FILE_COMPARISON_UPLOAD_KINDS.map((kind) =>
  sql.raw(`'${kind}'`),
);
const STATUS_SQL_VALUES = FILE_COMPARISON_UPLOAD_STATUSES.map((status) =>
  sql.raw(`'${status}'`),
);

/**
 * Short-lived objects for redlining two DOCX files that stella does not store:
 * the two staged inputs and the redline the comparison writes. Nothing here
 * becomes a document, a version, or matter content, so the table carries no
 * `workspace_id` and no reference to one.
 *
 * Every row expires, and the row is the only name the object has: the sweep in
 * `lib/file-comparison/sweep.ts` deletes the object before the row, and the
 * organization storage census reads this table so a deleted organization still
 * names what it staged. The declared MIME is always DOCX and is therefore a
 * constant rather than a column.
 */
export const fileComparisonUploads = p.pgTable(
  "file_comparison_uploads",
  {
    id: pUuid<"fileComparisonUpload">().primaryKey(),
    organizationId: safeOrganizationId("organization_id").notNull(),
    userId: p.text("user_id").notNull(),
    kind: p.text({ enum: FILE_COMPARISON_UPLOAD_KINDS }).notNull(),
    declaredName: p.varchar("declared_name", { length: 255 }).notNull(),
    declaredSize: p.bigint("declared_size", { mode: "number" }).notNull(),
    /** hex, and only for an input: the server writes the redline's bytes. */
    declaredSha256: p.varchar("declared_sha256", { length: 64 }),
    status: p
      .text({ enum: FILE_COMPARISON_UPLOAD_STATUSES })
      .notNull()
      .default("pending"),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    p
      .foreignKey({
        name: "file_comparison_uploads_organization_fk",
        columns: [table.organizationId],
        foreignColumns: [organization.id],
      })
      .onDelete("cascade"),
    p
      .foreignKey({
        name: "file_comparison_uploads_user_fk",
        columns: [table.userId],
        foreignColumns: [user.id],
      })
      .onDelete("cascade"),
    // The organization storage census walks the table in this order.
    p
      .index("file_comparison_uploads_org_created_idx")
      .on(table.organizationId, table.createdAt),
    // The sweep reads only what has expired, across every organization.
    p.index("file_comparison_uploads_expires_idx").on(table.expiresAt),
    p.check(
      "file_comparison_uploads_kind_check",
      sql`${table.kind} in (${sql.join(KIND_SQL_VALUES, sql`, `)})`,
    ),
    p.check(
      "file_comparison_uploads_status_check",
      sql`${table.status} in (${sql.join(STATUS_SQL_VALUES, sql`, `)})`,
    ),
    // An input is verified against the checksum it declared; a redline has
    // none to declare. Either combination the code cannot act on is refused
    // here rather than read back as a missing verification.
    p.check(
      "file_comparison_uploads_sha256_check",
      sql`(${table.kind} = 'input') = (${table.declaredSha256} IS NOT NULL)`,
    ),
    ...userOrganizationPolicies(),
  ],
);
