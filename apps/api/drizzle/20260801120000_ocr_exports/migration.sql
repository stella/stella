SET lock_timeout = '1s';--> statement-breakpoint
SET statement_timeout = '5s';--> statement-breakpoint

-- Additive nullable columns keep old API tasks and native extraction rows
-- compatible while the OCR worker rolls forward.
ALTER TABLE "extracted_content" ADD COLUMN IF NOT EXISTS "ocr_run_id" uuid;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD COLUMN IF NOT EXISTS "ocr_processor_version" integer;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD COLUMN IF NOT EXISTS "ocr_payload_ciphertext" bytea;--> statement-breakpoint
ALTER TABLE "extracted_content" ADD COLUMN IF NOT EXISTS "ocr_payload_iv" bytea;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'extracted_content_ocr_payload_complete_check'
      AND conrelid = 'extracted_content'::regclass
  ) THEN
    ALTER TABLE "extracted_content"
      ADD CONSTRAINT "extracted_content_ocr_payload_complete_check"
      CHECK (
        (
          "ocr_run_id" IS NULL
          AND "ocr_processor_version" IS NULL
          AND "ocr_payload_ciphertext" IS NULL
          AND "ocr_payload_iv" IS NULL
        ) OR (
          "ocr_run_id" IS NOT NULL
          AND "ocr_processor_version" > 0
          AND "ocr_payload_ciphertext" IS NOT NULL
          AND "ocr_payload_iv" IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END
$$;
