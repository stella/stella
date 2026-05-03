ALTER TABLE "user"
  ADD COLUMN IF NOT EXISTS "preferred_name" text,
  ADD COLUMN IF NOT EXISTS "word_edit_shortcut" text;
