SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Judges of a court, as that court publishes them, and the judges each
-- decision names. Public corpus data beside the decisions: no workspace
-- column, the same reader roles, and the same ingestion writer.
--
-- Identity is `(country, court, name_key)`. The publishers state a printed
-- name and nothing else stable, so the key is that name reduced to a match
-- form; it is the only thing a decision's printed name can be matched on.
CREATE TABLE "case_law_judges" (
  "id" uuid PRIMARY KEY NOT NULL,
  "country" varchar(3) NOT NULL,
  "court" varchar(512) NOT NULL,
  "full_name" varchar(256) NOT NULL,
  "name_key" varchar(256) NOT NULL,
  "term_start" date,
  "term_end" date,
  "external_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "portrait_s3_key" varchar(512),
  "portrait_source" text,
  "portrait_attribution" varchar(512),
  "portrait_content_type" varchar(64),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_judges_name_non_empty" CHECK ("full_name" <> ''),
  CONSTRAINT "case_law_judges_name_key_non_empty" CHECK ("name_key" <> ''),
  -- The four portrait columns are one fact. A key with no attribution would
  -- be served with nothing to credit it to, and an attribution with no key
  -- credits an image that does not exist.
  CONSTRAINT "case_law_judges_portrait_group" CHECK (
    ("portrait_s3_key" IS NULL) = ("portrait_source" IS NULL)
    AND ("portrait_s3_key" IS NULL) = ("portrait_attribution" IS NULL)
    AND ("portrait_s3_key" IS NULL) = ("portrait_content_type" IS NULL)
  ),
  -- Derived from PORTRAIT_SOURCES; a value the column accepts and this check
  -- rejects is what the two being written apart would produce.
  CONSTRAINT "case_law_judges_portrait_source_values"
    CHECK ("portrait_source" IS NULL OR "portrait_source" IN ('court-official')),
  -- The stored type is what the portrait route answers with, so the column is
  -- the boundary that keeps that header an image type.
  CONSTRAINT "case_law_judges_portrait_content_type_shape"
    CHECK ("portrait_content_type" IS NULL OR "portrait_content_type" LIKE 'image/%')
);--> statement-breakpoint

CREATE UNIQUE INDEX "case_law_judges_identity_idx"
  ON "case_law_judges" ("country", "court", "name_key");--> statement-breakpoint

-- `name_as_printed` is the decision's own statement and is stored whether or
-- not the roster holds the judge; `judge_id` is the match, and a null one is
-- a name the roster does not have yet.
CREATE TABLE "case_law_decision_judges" (
  "decision_id" uuid NOT NULL,
  "judge_id" uuid,
  "name_as_printed" varchar(256) NOT NULL,
  "name_key" varchar(256) NOT NULL,
  "role" text NOT NULL,
  "position" smallint NOT NULL,
  CONSTRAINT "case_law_decision_judges_pk"
    PRIMARY KEY ("decision_id", "role", "name_key"),
  CONSTRAINT "case_law_decision_judges_decision_id_fk"
    FOREIGN KEY ("decision_id")
    REFERENCES "case_law_decisions"("id")
    ON DELETE CASCADE,
  -- A roster row is not the decision's statement: losing it leaves the
  -- printed name and the key behind for the next import to match.
  CONSTRAINT "case_law_decision_judges_judge_id_fk"
    FOREIGN KEY ("judge_id")
    REFERENCES "case_law_judges"("id")
    ON DELETE SET NULL,
  CONSTRAINT "case_law_decision_judges_role_values"
    CHECK ("role" IN ('rapporteur', 'dissenting')),
  CONSTRAINT "case_law_decision_judges_name_non_empty"
    CHECK ("name_as_printed" <> '' AND "name_key" <> ''),
  CONSTRAINT "case_law_decision_judges_position_non_negative"
    CHECK ("position" >= 0)
);--> statement-breakpoint

CREATE INDEX "case_law_decision_judges_judge_idx"
  ON "case_law_decision_judges" ("judge_id");--> statement-breakpoint

-- The relink after a roster import walks exactly the unmatched rows.
CREATE INDEX "case_law_decision_judges_unmatched_idx"
  ON "case_law_decision_judges" ("name_key")
  WHERE "judge_id" IS NULL;--> statement-breakpoint

ALTER TABLE "case_law_judges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_judges"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "case_law_judges"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access"
  ON "case_law_judges"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader
  USING (true);--> statement-breakpoint

ALTER TABLE "case_law_decision_judges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access"
  ON "case_law_decision_judges"
  AS PERMISSIVE FOR ALL TO stella_ingestion
  USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access"
  ON "case_law_decision_judges"
  AS PERMISSIVE FOR SELECT TO stella
  USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access"
  ON "case_law_decision_judges"
  AS PERMISSIVE FOR SELECT TO stella_public_law_reader
  USING (true);--> statement-breakpoint

GRANT SELECT ON TABLE "case_law_judges" TO stella;--> statement-breakpoint
GRANT SELECT ON TABLE "case_law_decision_judges" TO stella;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_judges" TO stella_ingestion;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_decision_judges" TO stella_ingestion;--> statement-breakpoint

-- Exactly the columns a portrait is served from. The roster's own fields
-- stay on the owning service side.
GRANT SELECT (
  id,
  portrait_s3_key,
  portrait_attribution,
  portrait_content_type
) ON TABLE "case_law_judges"
  TO stella_public_law_reader;--> statement-breakpoint
GRANT SELECT (
  decision_id,
  judge_id,
  name_as_printed,
  name_key,
  role,
  position
) ON TABLE "case_law_decision_judges"
  TO stella_public_law_reader;
