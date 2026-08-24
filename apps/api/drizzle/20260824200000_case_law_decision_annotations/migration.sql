SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- A reader's highlights and comments on a decision. The decision is referenced
-- by id only: the public-law corpus may live in another database.
CREATE TABLE "case_law_decision_annotations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" varchar(128) NOT NULL,
  "user_id" text NOT NULL,
  "decision_id" uuid NOT NULL,
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
  CONSTRAINT "case_law_decision_annotations_organization_id_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "organization"("id")
    ON DELETE CASCADE,
  CONSTRAINT "case_law_decision_annotations_user_id_fk"
    FOREIGN KEY ("user_id")
    REFERENCES "user"("id")
    ON DELETE CASCADE,
  CONSTRAINT "case_law_decision_annotations_kind_values"
    CHECK ("kind" IN ('highlight', 'comment')),
  CONSTRAINT "case_law_decision_annotations_visibility_values"
    CHECK ("visibility" IN ('private', 'shared')),
  CONSTRAINT "case_law_decision_annotations_color_values"
    CHECK ("color" IS NULL OR "color" IN ('yellow', 'green', 'sky', 'violet', 'red')),
  CONSTRAINT "case_law_decision_annotations_style_values"
    CHECK ("style" IS NULL OR "style" IN ('highlight', 'underline', 'squiggly', 'strikethrough')),
  CONSTRAINT "case_law_decision_annotations_kind_shape"
    CHECK (
      ("kind" = 'highlight' AND "color" IS NOT NULL AND "style" IS NOT NULL AND "body" IS NULL)
      OR ("kind" = 'comment' AND "body" IS NOT NULL AND "body" <> '' AND "style" IS NULL)
    ),
  CONSTRAINT "case_law_decision_annotations_span_shape"
    CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset" AND "quote" <> '')
);--> statement-breakpoint

CREATE INDEX "case_law_decision_annotations_decision_idx"
  ON "case_law_decision_annotations" ("organization_id", "decision_id", "created_at", "id");--> statement-breakpoint

ALTER TABLE "case_law_decision_annotations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Organization-owned, author-controlled: a private note is the author's
-- alone until shared; only the author changes or removes one.
CREATE POLICY "organization_select"
  ON "case_law_decision_annotations"
  AS PERMISSIVE FOR SELECT TO stella
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND (
      visibility = 'shared'
      OR user_id = (SELECT current_setting('app.user_id', true))
    )
  );--> statement-breakpoint

CREATE POLICY "author_insert"
  ON "case_law_decision_annotations"
  AS PERMISSIVE FOR INSERT TO stella
  WITH CHECK (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

CREATE POLICY "author_update"
  ON "case_law_decision_annotations"
  AS PERMISSIVE FOR UPDATE TO stella
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );--> statement-breakpoint

CREATE POLICY "author_delete"
  ON "case_law_decision_annotations"
  AS PERMISSIVE FOR DELETE TO stella
  USING (
    organization_id = (SELECT current_setting('app.organization_id', true))
    AND user_id = (SELECT current_setting('app.user_id', true))
  );
