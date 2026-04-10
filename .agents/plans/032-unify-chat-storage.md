# Plan: Unify Chat Storage

Date: 2026-04-07

## Goal

Collapse Stella chat into a single threads table and a single messages table, with nullable `workspaceId` indicating workspace context. Keep the code-level global/workspace discriminated union for clarity, but remove duplicated storage, handlers, and endpoints so chat behavior differs only by whether a workspace ID is present.

## Design Decisions

- **Single chat persistence model**: Use one `chat_threads` table and one `chat_messages` table with nullable `workspaceId`. This removes duplicated storage and endpoint logic while keeping workspace context explicit.
- **General conditional RLS helper**: Add a reusable policy helper for tables that should use workspace RLS when `workspaceId` is set and organization RLS when it is null. This keeps the policy name general and reusable outside chat.
- **No migration path**: This is a full refactor before schema push. Remove the obsolete tables/enum directly instead of carrying transitional schema or data migration code.
- **User files are thread-owned records over hash-addressed objects**: Store S3 objects under `userId` and file hash, and let `user_files` be per-thread records pointing to those objects. Re-uploading the same file in the same thread should reuse the existing `user_files` row; uploading the same file in another thread should create a new row pointing to the same S3 key.
- **Thread deletion owns file cleanup**: Deleting any thread must delete its `user_files` rows and remove the underlying S3 object only when no remaining `user_files` row references that same object. This avoids orphaned files and avoids accidental S3 deletion while another thread still references the object.
- **Restrict FKs for user-file cleanup safety**: Use restrictive foreign keys from chat threads to `user_files` so DB cascades cannot silently bypass S3 cleanup logic.
- **Single chat API surface**: Keep one `/v1/chat` route family. The frontend passes optional `workspaceId`; backend uses that to select tools and enforce access.
- **Keep discriminated unions in app code**: Continue representing `global` vs `workspace` in TypeScript where it improves readability, but stop mapping those branches to separate tables or route trees.

## Scope

**In scope:**

- Replace `chat_threads` + `chat_ws_threads` with one threads table
- Replace `chat_messages` + `chat_ws_messages` with one messages table
- Add a general nullable-`workspaceId` RLS helper and apply it to unified chat tables
- Remove `user_file_chat_scope` enum and related branching
- Collapse global/workspace chat handlers into one backend send/read/delete path
- Remove workspace chat endpoints and route mounting
- Keep grouped thread listing split into global and workspace buckets
- Refactor user-file deduplication around `userId` + file hash + thread ownership
- Delete thread-owned files on thread deletion, removing shared S3 objects only when unreferenced
- Add restrictive FK behavior so file deletion cannot bypass S3 cleanup

**Out of scope:**

- Any migration or backfill logic
- Changing the user-facing chat UX beyond what the backend simplification requires
- Broad cleanup unrelated to unified chat/user-file ownership

## Implementation

- `apps/api/src/db/rls.ts`
  Add a general policy helper for tables that should use workspace RLS when `workspaceId` is set and organization RLS when it is null.

- `apps/api/src/db/schema.ts`
  Remove `chat_ws_threads`, `chat_ws_messages`, and `userFileChatScopeEnum`.
  Add nullable `workspaceId` to unified `chat_threads` and `chat_messages`.
  Apply the new general nullable-`workspaceId` policy helper to those tables.
  Remove `chatScope` from `user_files`.
  Add fields/indexes needed for hash-based storage reuse, likely around `sha256Hex`, `s3Key`, `threadId`, `workspaceId`, and user/thread lookup paths.
  Change thread/user-file foreign key behavior to restrict rather than cascade where cleanup must go through application logic.

- `apps/api/src/handlers/chat/`
  Merge `send-message` / `send-workspace-message`, `get-messages` / `get-workspace-messages`, and `delete-thread` / `delete-workspace-thread` into unified handlers that accept optional `workspaceId`.
  Keep discriminated unions in handler inputs and helper calls for clarity.
  Keep grouped thread listing split in API response even though storage is unified.

- `apps/api/src/handlers/chat/routes.ts`
  Mount only the unified chat endpoints.
  Remove workspace chat routes from `apps/api/src/handlers/workspaces/routes.ts`.

- `apps/api/src/handlers/chat/run-persisted-chat.ts`
  Keep tool selection and prompt branching based on optional `workspaceId`.
  Continue using the discriminated union internally so global and workspace tool availability stays explicit.

- `apps/api/src/handlers/user-files/*`
  Replace `chatScope` validation with optional `workspaceId` + `threadId` checks.
  Refactor upload to:
  reserve or reuse thread-owned `user_files` rows appropriately,
  reuse existing S3 objects by `userId` + file hash,
  skip creating duplicate `user_files` rows for the same file in the same thread,
  create a fresh `user_files` row for another thread pointing to the same S3 object.
  Refactor delete flow so thread deletion removes rows first through application logic and only deletes the S3 object when no rows still reference it.

- `apps/api/src/handlers/files/utils.ts` and shared storage helpers
  Change key construction to use `userId` + file hash rather than file ID.
  Keep this isolated so future upload flows reuse the same storage identity rules.

- `apps/api/src/types.ts` and `apps/api/src/handlers/chat/types.ts`
  Simplify exported storage/content types to the unified model while keeping the code-level global/workspace discriminated union.

- `apps/web/src/routes/_protected.chat/-queries.ts`
  Point all send/read calls at `/v1/chat`.
  Include optional `workspaceId` in request bodies and cache identity.
  Keep grouped thread handling split for UI presentation.

- `apps/web/src/lib/chat-thread-ref.ts` and chat consumers
  Keep the discriminated union for routing and UI context, but stop treating it as a backend route switch.

- `apps/web/src/components/chat-input-provider.tsx` and related send flows
  Upload files through the unified endpoint with optional `workspaceId`.
  Preserve eager upload and per-file state.

## Test Cases

- Global thread create/read/send/delete works with `workspaceId = null`
- Workspace thread create/read/send/delete works with `workspaceId` set
- Grouped thread listing remains split into global and workspace buckets
- Unified RLS allows org-scoped rows only when `workspaceId` is null
- Unified RLS allows workspace-scoped rows only for accessible workspaces
- Workspace-only tools are available only when `workspaceId` is present
- Uploading the same file twice in the same thread reuses the existing `user_files` row
- Uploading the same file in another thread creates a new `user_files` row but reuses the same S3 object
- Deleting a thread deletes its `user_files` rows
- Deleting a thread deletes the S3 object only when no remaining `user_files` row references it
- Restrictive FK behavior prevents accidental DB-level deletion paths that skip S3 cleanup
