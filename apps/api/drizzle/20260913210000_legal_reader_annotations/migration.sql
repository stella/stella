SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

-- A reader's highlights and comments now sit on statutes as well as on
-- decisions, so the table names the document it marks with a discriminator
-- instead of naming one corpus.
--
-- A cutover, not a rename: migrations run before the new API tasks finish
-- rolling out, so the tasks still serving the old build have to keep reading
-- the table they were deployed against, and a rollback has to find it too.
-- `case_law_decision_annotations` is therefore left exactly as it is, rows,
-- policies and grants included; its rows are copied here, and a follow-up
-- migration drops it once this deploy is out. There are no dual writes: for
-- the length of the rollout a mark left on the old build stays on the old
-- table, which the drop migration reconciles.
CREATE TABLE "legal_reader_annotations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "group_id" uuid,
  "kind" text NOT NULL,
  "visibility" text DEFAULT 'private' NOT NULL,
  "color" text,
  "style" text,
  "block_anchor_id" varchar(64) NOT NULL,
  "start_offset" integer NOT NULL,
  "end_offset" integer NOT NULL,
  "quote" varchar(2000) NOT NULL,
  "body" varchar(10000),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "legal_reader_annotations_organization_id_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "organization"("id")
    ON DELETE CASCADE,
  CONSTRAINT "legal_reader_annotations_user_id_fk"
    FOREIGN KEY ("user_id")
    REFERENCES "user"("id")
    ON DELETE CASCADE,
  -- Which corpus the target id names.
  CONSTRAINT "legal_reader_annotations_target_type_values"
    CHECK ("target_type" IN ('decision', 'statute')),
  CONSTRAINT "legal_reader_annotations_kind_values"
    CHECK ("kind" IN ('highlight', 'comment')),
  CONSTRAINT "legal_reader_annotations_visibility_values"
    CHECK ("visibility" IN ('private', 'shared')),
  CONSTRAINT "legal_reader_annotations_color_values"
    CHECK ("color" IS NULL OR "color" IN ('yellow', 'green', 'sky', 'violet', 'red')),
  CONSTRAINT "legal_reader_annotations_style_values"
    CHECK ("style" IS NULL OR "style" IN ('highlight', 'underline', 'squiggly', 'strikethrough')),
  CONSTRAINT "legal_reader_annotations_kind_shape"
    CHECK (
      ("kind" = 'highlight' AND "color" IS NOT NULL AND "style" IS NOT NULL AND "body" IS NULL)
      OR ("kind" = 'comment' AND "style" IS NULL AND (("body" IS NOT NULL AND "body" <> '') OR "group_id" IS NOT NULL))
    ),
  CONSTRAINT "legal_reader_annotations_span_shape"
    CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset" AND "quote" <> '')
);--> statement-breakpoint

-- The listing reads one document's notes, and a target id is a UUID, so the
-- index leads with the tenant and the id; the discriminator narrows nothing a
-- UUID has not already narrowed.
CREATE INDEX "legal_reader_annotations_target_idx"
  ON "legal_reader_annotations" ("organization_id", "target_id", "created_at", "id");--> statement-breakpoint

-- A mark over several paragraphs is one row per paragraph under one group;
-- a change to the mark reaches every row of the group.
CREATE INDEX "legal_reader_annotations_group_idx"
  ON "legal_reader_annotations" ("organization_id", "group_id")
  WHERE "group_id" IS NOT NULL;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON "legal_reader_annotations" TO stella;--> statement-breakpoint

ALTER TABLE "legal_reader_annotations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Organization-owned, author-controlled: a private note is the author's
-- alone until shared; only the author changes or removes one. The same
-- policies the table being retired carries, so the cutover moves no line.
CREATE POLICY "organization_select"
  ON "legal_reader_annotations"
  AS PERMISSIVE FOR SELECT TO stella
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND (
      visibility = 'shared'
      OR user_id = (SELECT current_setting('app.user_id', true))
    )
  );--> statement-breakpoint

CREATE POLICY "author_insert"
  ON "legal_reader_annotations"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

CREATE POLICY "author_update"
  ON "legal_reader_annotations"
  AS PERMISSIVE FOR UPDATE TO stella
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

CREATE POLICY "author_delete"
  ON "legal_reader_annotations"
  AS PERMISSIVE FOR DELETE TO stella
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

-- The rows themselves. Every existing mark is a note on a decision, and the
-- ids are carried over unchanged so a mark keeps its identity across the
-- cutover: the group ties hold, and a re-run of this statement is a no-op
-- because the primary key already holds the row.
-- stella-migration-safety: reviewed insert-select - one read of case_law_decision_annotations, a reader-notes table three weeks old and not registered as high-volume; the ON CONFLICT arbiter is the table's own primary key, so a replay copies nothing twice
INSERT INTO "legal_reader_annotations" (
  "id", "organization_id", "user_id", "target_type", "target_id", "group_id",
  "kind", "visibility", "color", "style", "block_anchor_id", "start_offset",
  "end_offset", "quote", "body", "created_at", "updated_at"
)
SELECT
  "id", "organization_id", "user_id", 'decision', "decision_id", "group_id",
  "kind", "visibility", "color", "style", "block_anchor_id", "start_offset",
  "end_offset", "quote", "body", "created_at", "updated_at"
FROM "case_law_decision_annotations"
ON CONFLICT ON CONSTRAINT "legal_reader_annotations_pkey" DO NOTHING;
