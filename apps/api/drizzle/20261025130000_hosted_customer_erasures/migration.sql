CREATE TABLE "hosted_customer_erasures" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "external_customer_ref" text NOT NULL UNIQUE,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error_code" varchar(64),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "hosted_customer_erasures_status_domain" CHECK (status IN ('pending', 'erased', 'failed')),
  CONSTRAINT "hosted_customer_erasures_attempts_nonnegative" CHECK (attempts >= 0)
);
--> statement-breakpoint
CREATE INDEX "hosted_customer_erasures_due_idx" ON "hosted_customer_erasures" ("status", "next_attempt_at");
--> statement-breakpoint
ALTER TABLE "hosted_customer_erasures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "hosted_customer_erasures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "hosted_customer_erasures_no_stella_access" ON "hosted_customer_erasures" FOR ALL TO stella USING (false) WITH CHECK (false);
