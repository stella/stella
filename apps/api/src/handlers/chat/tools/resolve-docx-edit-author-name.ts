/**
 * Resolve the acting user's DOCX tracked-changes author name for
 * `edit_workspace_document`. Mirrors `getWordEditAuthorName` in
 * `apps/web/src/routes/_protected.chat/-hooks/use-chat-user-context.ts`
 * exactly (preferred name first, falling back to the account name) --
 * that client-side helper is the canonical resolution the live editor
 * already uses to attribute the user's OWN tracked changes and comments
 * (`createEditorRefBridge({ author: userContext.wordEditAuthorName, ... })`
 * in `file-chat-overlay.tsx`). AI-applied edits must be attributed
 * identically, never to a fabricated name like "Stella AI" or "AI".
 *
 * This is the server-side counterpart because the headless tool has no
 * client to source `userContext` from -- it resolves the same two columns
 * (`name`, `preferredName`) directly from the user's account row instead.
 */

import { Result } from "better-result";

import type { SafeDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";

type ResolveDocxEditAuthorNameOptions = {
  safeDb: SafeDb;
  userId: SafeId<"user">;
};

/**
 * Returns the trimmed author name, or `null` when neither `preferredName`
 * nor `name` resolves to non-blank text (or the user row's lookup fails)
 * -- callers MUST fail closed on `null` rather than substitute a default
 * author.
 */
export const resolveDocxEditAuthorName = async ({
  safeDb,
  userId,
}: ResolveDocxEditAuthorNameOptions): Promise<string | null> => {
  const result = await safeDb((tx) =>
    tx.query.user.findFirst({
      where: { id: { eq: userId } },
      columns: { name: true, preferredName: true },
    }),
  );
  if (Result.isError(result)) {
    return null;
  }

  const preferredName = result.value?.preferredName?.trim();
  if (preferredName) {
    return preferredName;
  }

  const name = result.value?.name.trim();
  return name || null;
};
