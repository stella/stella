SET lock_timeout = '1s';
--> statement-breakpoint
SET statement_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "chat_messages"
ADD COLUMN "memory_extraction_eligible" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_messages"
ALTER COLUMN "memory_extraction_eligible" SET DEFAULT false;
