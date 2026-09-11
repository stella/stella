SET LOCAL lock_timeout = '1s';--> statement-breakpoint
SET LOCAL statement_timeout = '5s';--> statement-breakpoint

CREATE TABLE "case_law_statute_citation_memberships" (
  "decision_id" uuid NOT NULL REFERENCES "case_law_decisions"("id") ON DELETE CASCADE,
  "source_id" uuid NOT NULL REFERENCES "case_law_sources"("id"),
  "jurisdiction" varchar(3) NOT NULL,
  "work_eli" varchar(512) NOT NULL,
  "target_type" text NOT NULL,
  "anchor" varchar(256) NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_statute_citation_memberships_pkey"
    PRIMARY KEY ("decision_id", "jurisdiction", "work_eli", "target_type", "anchor"),
  CONSTRAINT "case_law_statute_citation_memberships_target_type_values"
    CHECK ("target_type" IN ('work', 'provision')),
  CONSTRAINT "case_law_statute_citation_memberships_target_shape"
    CHECK (
      ("target_type" = 'work' AND "anchor" = '')
      OR ("target_type" = 'provision' AND "anchor" <> '')
    )
);--> statement-breakpoint

CREATE INDEX "case_law_statute_citation_memberships_target_idx"
  ON "case_law_statute_citation_memberships"
  ("jurisdiction", "work_eli", "target_type", "anchor");--> statement-breakpoint

CREATE INDEX "case_law_statute_citation_memberships_source_idx"
  ON "case_law_statute_citation_memberships" ("source_id");--> statement-breakpoint

CREATE TABLE "case_law_statute_citation_counts" (
  "source_id" uuid NOT NULL REFERENCES "case_law_sources"("id"),
  "jurisdiction" varchar(3) NOT NULL,
  "work_eli" varchar(512) NOT NULL,
  "target_type" text NOT NULL,
  "anchor" varchar(256) NOT NULL,
  "decision_count" integer NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_statute_citation_counts_pkey"
    PRIMARY KEY ("jurisdiction", "work_eli", "target_type", "anchor", "source_id"),
  CONSTRAINT "case_law_statute_citation_counts_target_type_values"
    CHECK ("target_type" IN ('work', 'provision')),
  CONSTRAINT "case_law_statute_citation_counts_target_shape"
    CHECK (
      ("target_type" = 'work' AND "anchor" = '')
      OR ("target_type" = 'provision' AND "anchor" <> '')
    ),
  CONSTRAINT "case_law_statute_citation_counts_positive"
    CHECK ("decision_count" > 0)
);--> statement-breakpoint

CREATE INDEX "case_law_statute_citation_counts_source_idx"
  ON "case_law_statute_citation_counts" ("source_id");--> statement-breakpoint

CREATE TABLE "case_law_statute_citation_count_state" (
  "key" varchar(32) PRIMARY KEY NOT NULL,
  "status" text DEFAULT 'building' NOT NULL,
  "cursor_decision_id" uuid,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "case_law_statute_citation_count_state_key"
    CHECK ("key" = 'global'),
  CONSTRAINT "case_law_statute_citation_count_state_status_values"
    CHECK ("status" IN ('building', 'ready'))
);--> statement-breakpoint

INSERT INTO "case_law_statute_citation_count_state" ("key", "status")
SELECT 'global', CASE
  WHEN EXISTS (SELECT 1 FROM "case_law_provision_citations")
    THEN 'building'
  ELSE 'ready'
END;--> statement-breakpoint

CREATE FUNCTION "increment_case_law_statute_citation_count"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO "case_law_statute_citation_counts" (
    "source_id", "jurisdiction", "work_eli", "target_type", "anchor", "decision_count"
  ) VALUES (
    NEW."source_id", NEW."jurisdiction", NEW."work_eli", NEW."target_type", NEW."anchor", 1
  )
  ON CONFLICT ON CONSTRAINT "case_law_statute_citation_counts_pkey"
  DO UPDATE SET
    "decision_count" = "case_law_statute_citation_counts"."decision_count" + 1,
    "updated_at" = now();
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "decrement_case_law_statute_citation_count"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM "case_law_statute_citation_counts"
  WHERE "source_id" = OLD."source_id"
    AND "jurisdiction" = OLD."jurisdiction"
    AND "work_eli" = OLD."work_eli"
    AND "target_type" = OLD."target_type"
    AND "anchor" = OLD."anchor"
    AND "decision_count" = 1;

  IF NOT FOUND THEN
    UPDATE "case_law_statute_citation_counts"
    SET "decision_count" = "decision_count" - 1,
        "updated_at" = now()
    WHERE "source_id" = OLD."source_id"
      AND "jurisdiction" = OLD."jurisdiction"
      AND "work_eli" = OLD."work_eli"
      AND "target_type" = OLD."target_type"
      AND "anchor" = OLD."anchor"
      AND "decision_count" > 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'citation count missing for deleted membership';
    END IF;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "case_law_statute_citation_membership_insert"
AFTER INSERT ON "case_law_statute_citation_memberships"
FOR EACH ROW EXECUTE FUNCTION "increment_case_law_statute_citation_count"();--> statement-breakpoint

CREATE TRIGGER "case_law_statute_citation_membership_delete"
AFTER DELETE ON "case_law_statute_citation_memberships"
FOR EACH ROW EXECUTE FUNCTION "decrement_case_law_statute_citation_count"();--> statement-breakpoint

CREATE FUNCTION "sync_case_law_statute_citation_membership"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  citation_source_id uuid;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') AND OLD."work_eli" IS NOT NULL THEN
    DELETE FROM "case_law_statute_citation_memberships" membership
    WHERE membership."decision_id" = OLD."decision_id"
      AND membership."jurisdiction" = OLD."jurisdiction"
      AND membership."work_eli" = OLD."work_eli"
      AND (
        (
          membership."target_type" = 'work'
          AND NOT EXISTS (
            SELECT 1 FROM "case_law_provision_citations" citation
            WHERE citation."decision_id" = OLD."decision_id"
              AND citation."jurisdiction" = OLD."jurisdiction"
              AND citation."work_eli" = OLD."work_eli"
          )
        )
        OR (
          membership."target_type" = 'provision'
          AND membership."anchor" = OLD."anchor"
          AND NOT EXISTS (
            SELECT 1 FROM "case_law_provision_citations" citation
            WHERE citation."decision_id" = OLD."decision_id"
              AND citation."jurisdiction" = OLD."jurisdiction"
              AND citation."work_eli" = OLD."work_eli"
              AND citation."anchor" = OLD."anchor"
          )
        )
      );
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."work_eli" IS NOT NULL THEN
    SELECT decision."source_id" INTO STRICT citation_source_id
    FROM "case_law_decisions" decision
    WHERE decision."id" = NEW."decision_id";

    INSERT INTO "case_law_statute_citation_memberships" (
      "decision_id", "source_id", "jurisdiction", "work_eli", "target_type", "anchor"
    ) VALUES (
      NEW."decision_id", citation_source_id, NEW."jurisdiction", NEW."work_eli", 'work', ''
    )
    ON CONFLICT DO NOTHING;

    IF NEW."anchor" <> '' THEN
      INSERT INTO "case_law_statute_citation_memberships" (
        "decision_id", "source_id", "jurisdiction", "work_eli", "target_type", "anchor"
      ) VALUES (
        NEW."decision_id", citation_source_id, NEW."jurisdiction", NEW."work_eli", 'provision', NEW."anchor"
      )
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "case_law_provision_citation_membership_insert"
AFTER INSERT ON "case_law_provision_citations"
FOR EACH ROW EXECUTE FUNCTION "sync_case_law_statute_citation_membership"();--> statement-breakpoint

CREATE TRIGGER "case_law_provision_citation_membership_delete"
AFTER DELETE ON "case_law_provision_citations"
FOR EACH ROW EXECUTE FUNCTION "sync_case_law_statute_citation_membership"();--> statement-breakpoint

CREATE TRIGGER "case_law_provision_citation_membership_update"
AFTER UPDATE OF "decision_id", "jurisdiction", "work_eli", "anchor"
ON "case_law_provision_citations"
FOR EACH ROW EXECUTE FUNCTION "sync_case_law_statute_citation_membership"();--> statement-breakpoint

CREATE FUNCTION "sync_case_law_statute_citation_membership_source"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  DELETE FROM "case_law_statute_citation_memberships"
  WHERE "decision_id" = NEW."id";

  INSERT INTO "case_law_statute_citation_memberships" (
    "decision_id", "source_id", "jurisdiction", "work_eli", "target_type", "anchor"
  )
  SELECT citation."decision_id", NEW."source_id",
    citation."jurisdiction", citation."work_eli", 'work', ''
  FROM "case_law_provision_citations" citation
  WHERE citation."decision_id" = NEW."id" AND citation."work_eli" IS NOT NULL
  UNION
  SELECT citation."decision_id", NEW."source_id",
    citation."jurisdiction", citation."work_eli", 'provision', citation."anchor"
  FROM "case_law_provision_citations" citation
  WHERE citation."decision_id" = NEW."id"
    AND citation."work_eli" IS NOT NULL
    AND citation."anchor" <> ''
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "case_law_decision_statute_citation_membership_source"
AFTER UPDATE OF "source_id" ON "case_law_decisions"
FOR EACH ROW
WHEN (OLD."source_id" IS DISTINCT FROM NEW."source_id")
EXECUTE FUNCTION "sync_case_law_statute_citation_membership_source"();--> statement-breakpoint

ALTER TABLE "case_law_statute_citation_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_statute_citation_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "case_law_statute_citation_count_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "case_law_ingestion_access" ON "case_law_statute_citation_memberships"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_statute_citation_counts"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "case_law_ingestion_access" ON "case_law_statute_citation_count_state"
  AS PERMISSIVE FOR ALL TO "stella_ingestion" USING (true) WITH CHECK (true);--> statement-breakpoint

CREATE POLICY "case_law_global_access" ON "case_law_statute_citation_counts"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "case_law_global_access" ON "case_law_statute_citation_count_state"
  AS PERMISSIVE FOR SELECT TO "stella" USING (true);--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_statute_citation_counts"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (
    EXISTS (
      SELECT 1
      FROM "case_law_sources" citation_count_source
      WHERE citation_count_source."id" = "case_law_statute_citation_counts"."source_id"
        AND (
          citation_count_source."descriptor" IS NULL
          OR (citation_count_source."descriptor" ->> 'allowsRedistribution') = 'true'
        )
    )
  );--> statement-breakpoint
CREATE POLICY "public_law_reader_access" ON "case_law_statute_citation_count_state"
  AS PERMISSIVE FOR SELECT TO "stella_public_law_reader" USING (true);--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_statute_citation_memberships" TO "stella_ingestion";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE "case_law_statute_citation_counts" TO "stella_ingestion";--> statement-breakpoint
GRANT SELECT, UPDATE
  ON TABLE "case_law_statute_citation_count_state" TO "stella_ingestion";--> statement-breakpoint
GRANT SELECT ("source_id", "jurisdiction", "work_eli", "target_type", "anchor", "decision_count", "updated_at")
  ON TABLE "case_law_statute_citation_counts"
  TO "stella", "stella_public_law_reader";--> statement-breakpoint
GRANT SELECT ("key", "status", "updated_at")
  ON TABLE "case_law_statute_citation_count_state"
  TO "stella", "stella_public_law_reader";
