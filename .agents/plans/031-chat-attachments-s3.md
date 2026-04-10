# Plan: Chat User Files in S3

Date: 2026-04-07

## Goal

Drop chat attachment persistence as base64 data URLs and move chat uploads to a general private `user_files` store backed by S3. Chat messages should persist only stable typed file refs such as `stella://file::${id}`, while the backend rehydrates those refs into transient AI-SDK-compatible file payloads only at runtime.

## Design Decisions

- **Use a general `user_files` table, not a chat-specific table**: these uploads are private user-owned files, not workspace files and not organization files. Chat is just the first consumer.
- **Use typed file refs in message parts**: persist `file.url` as a template-literal type like `type ChatUserFileUrl = \`stella://file::${string}\`` so the database stores a stable internal ref instead of bytes or URLs that expire.
- **Keep storage rooted only under `userId`**: S3 keys should live under a user-owned prefix such as `${userId}/${fileId}.${ext}`. Thread and workspace context belong in metadata, not in the storage path.
- **Upload on file add, one file per request**: follow the same shape as entity upload. Adding two files produces two upload requests. The frontend tracks `pending`, `uploaded`, and `failed` per file.
- **Hydrate refs only on the backend runtime path**: persisted messages keep `stella://file::${id}` refs. When the backend re-reads those messages for model execution, it resolves the file row, downloads the bytes, and converts them to the transient shape the AI SDK needs. That compatibility layer must never write base64 back to the database.
- **Store extracted views on the user-file row**: `display-document` should continue to work without reparsing source files on every tool call. DOCX, TXT, CSV, and Markdown chat files should store the extracted text views needed by chat directly on the row.
- **Serve content through stable app endpoints**: the frontend sees `stella://file::${id}`, parses out the ID, and calls a dedicated user-file content endpoint. Persisted chat messages never store presigned URLs.
- **Keep chat lifecycle metadata separate from storage identity**: `user_files` should stay general, but it still needs nullable chat-origin metadata such as `chatScope`, `threadId`, and `workspaceId` so global-thread cleanup is reliable and workspace-thread cleanup can intentionally do nothing.
- **No migration path**: this is a rewrite. Existing base64-backed chat attachments are not migrated.

## Scope

**In scope:**

- Add a general `user_files` table for private user-owned uploads used by chat
- Replace base64-backed chat `file` parts with typed `stella://file::${id}` refs
- Upload each file as soon as the user adds it, one file per request
- Store user files in S3 under a path rooted only at `${userId}/...`
- Keep `display-document` working from stored extracted views
- Delete global-thread user files from S3 and the table when deleting a global thread
- Leave workspace-thread user files untouched when deleting a workspace thread
- Refactor scan/upload/extract logic into reusable helpers that chat and other file flows can share

**Out of scope:**

- Migrating or backfilling existing base64-backed chat attachments
- Storing workspace chat uploads as entity fields or workspace-visible files
- Automatic cleanup of workspace chat files after thread deletion
- Broad redesign of unrelated non-chat file UX beyond extracting shared helper logic

## Implementation

- `apps/api/src/db/schema.ts`:
  Add a `userFiles` table with fields for `id`, `userId`, `fileName`, `mimeType`, `sizeBytes`, `sha256Hex`, `s3Key`, `status`, `views`, `scanWarnings`, `createdAt`, and `updatedAt`, plus nullable chat-origin metadata such as `chatScope`, `threadId`, and `workspaceId`.
  Treat `userId` as the ownership boundary for this table. Workspace chat files still live here because they are private user files, not workspace field files.
  Index for the main access paths: `(userId, createdAt)`, `(chatScope, threadId, createdAt)`, and `(workspaceId, createdAt)` for workspace-chat lookups.

- `apps/api/src/handlers/chat/types.ts`:
  Export the shared file-ref contract, for example `ChatUserFileUrl = \`stella://file::${string}\``.
  Bump chat message content version and make the persisted `file` parts use `stella://file::${id}` plus display metadata (`filename`, `mediaType`) instead of inline payloads.

- `apps/api/src/handlers/chat/chat-schema.ts`:
  Stop accepting raw base64-backed file payloads in chat messages.
  Validate that each incoming file part with a chat user-file URL matches the `stella://file::${id}` contract and belongs to a ready `user_files` row accessible to the current user and chat scope.
  Remove attachment extraction work from message normalization; upload finalization should already have done it.

- `apps/api/src/handlers/chat/chat-file-parts.ts`:
  Delete or reduce this module to file-ref validation only.
  Base64 parsing, data-URL MIME checks, and inline DOCX extraction should disappear from the chat send path.

- `apps/api/src/handlers/chat/tools/attachment-types.ts` and `apps/api/src/handlers/chat/tools/document-tools.ts`:
  Replace `dataUrl`-based attachment types with stored user-file records keyed by file ID.
  Build `display-document` from user-file rows and their stored extracted views, not from transient request-time arrays.
  Use file IDs internally for lookup so duplicate filenames are not ambiguous.

- `apps/api/src/handlers/chat/send-message.ts` and `apps/api/src/handlers/chat/send-workspace-message.ts`:
  Accept only messages that reference already-uploaded user files.
  Persist the file-ref-bearing parts directly in `chat_messages` / `chat_ws_messages`.
  Resolve the referenced file rows once before chat execution and pass them into the runtime file context.

- `apps/api/src/handlers/chat/run-persisted-chat.ts`:
  Resolve `stella://file::${id}` refs before building model messages.
  For image and PDF files, load the stored bytes from S3 and inject a transient AI-SDK-compatible file input, including base64/data-URL conversion if that remains the SDK requirement on the backend, without writing that payload back to the database.
  For DOCX, TXT, CSV, and Markdown files, use the extracted `views` stored on the user-file row and expose them to `display-document`.

- `apps/api/src/handlers/chat/get-messages.ts` and `apps/api/src/handlers/chat/get-workspace-messages.ts`:
  Return persisted file parts as-is with `stella://file::${id}` URLs.
  Do not convert user-file refs to base64 in read APIs; base64 conversion belongs only to the backend model-execution path.

- `apps/api/src/handlers/chat/delete-thread.ts`:
  Before deleting the global thread, load the matching global-chat `user_files` rows, delete their S3 objects, then delete those rows and the thread records.
  Use the table as the source of truth; do not scan message JSON to discover files.

- `apps/api/src/handlers/chat/delete-workspace-thread.ts`:
  Delete only the workspace thread and its messages.
  Do not touch workspace-chat `user_files` rows or S3 objects.

- New user-file handlers:
  Add dedicated upload endpoints for global and workspace chat files. They should reserve a `user_files` row, ingest the uploaded bytes through the shared helper pipeline, and return the `stella://file::${id}` ref plus display metadata needed by the chat UI.
  Add a shared user-file content endpoint such as `/v1/user-files/:fileId/content` that resolves a `user_files` row, auth-checks it, and returns the file content through a fresh S3 redirect or a streamed response when needed.

- `apps/api/src/handlers/files/utils.ts` or a new shared storage helper module:
  Add user-file key builders.
  User files should use a path rooted only at `${userId}/`, for example `${userId}/${fileId}.${ext}`.
  Keep key construction isolated so future upload flows can reuse it without duplicating path logic.

- Shared ingestion utilities:
  Extract the non-chat-specific byte pipeline into reusable helpers:
  `prepareUploadBytes(...)` for filename sanitization, size checks, hashing, and `scanFile`;
  `buildUserFileViews(...)` for DOCX and text extraction;
  `storeUploadedObject(...)` for S3 writes with a caller-supplied key builder;
  `resolveUserFile(...)` for loading a `user_files` row plus auth context from `stella://file::${id}`.
  Refactor `apps/api/src/handlers/entities/create-from-buffer.ts` and `apps/api/src/handlers/entities/upload.ts` to use the same lower-level helpers where possible, so scanning and upload behavior stop diverging across the app.

- `apps/web/src/components/chat-input-provider.tsx`:
  Change attachment state from raw `File[]` waiting to be embedded in the chat request into user-file drafts with explicit upload lifecycle, for example `pending`, `uploaded`, and `failed`.
  Start the upload when the user adds a file, one file per request, and store the returned file ID, `stella://file::${id}` ref, filename, and MIME type on success.
  Keep the HTML editor flow unchanged; only the file path moves to eager upload plus pending-state management.

- `apps/web/src/routes/_protected.chat/-lib/build-chat-request-message.ts`:
  Stop converting `File[]` into `FileList`.
  Build chat message file parts only from successfully uploaded user files, carrying `url: stella://file::${id}` plus `filename` and `mediaType`.

- `apps/web/src/routes/_protected.chat/-queries.ts` and chat send flow:
  The AI SDK transport should only send text plus file refs; it should never serialize file contents into the chat request body.
  Message send must block while any selected file is still pending and fail fast if any file upload failed.

- `apps/web/src/components/chat/chat-thread-messages.tsx`:
  When a file part uses a `stella://file::${id}` URL, derive the stable user-file content endpoint from the ID.
  Use that endpoint for image previews and file download/display links.
  Remove any assumption that `part.url` is directly browser-loadable or already a real URL.

- `apps/web/src/components/chat/chat-ui-tools.ts` and related UI:
  Keep `display-document` wired to the backend tool output.
  Ensure user-file-backed document previews still render even though the original chat message only stores a `stella://file::${id}` ref.

## Test Cases

- Global chat file upload stores bytes in S3 under `${userId}/...`, creates a `user_files` row, and returns a `stella://file::${id}` ref
- Workspace chat file upload stores bytes in S3 under `${userId}/...`, creates a `user_files` row with workspace-chat origin metadata, and returns a `stella://file::${id}` ref
- Adding two files from the chat input produces two independent upload requests and the UI shows per-file pending state
- Chat send rejects file parts that are not typed `stella://file::${id}` refs
- Chat send rejects user-file refs that do not belong to the current user and chat scope
- Chat send is disabled or blocked while any selected file is pending upload
- A failed file upload is visible in the input and is not included in the sent message until retried or removed
- The frontend can render and download image, PDF, DOCX, TXT, CSV, and Markdown files from `stella://file::${id}` refs without ever persisting presigned URLs
- `runPersistedChat` resolves image and PDF user files into model inputs without writing base64 into stored messages
- Re-reading persisted messages for a later assistant turn converts `stella://file::${id}` refs into transient AI-SDK-compatible file payloads on the backend only
- `display-document` works for DOCX and text-like files using the views stored on the user-file row
- Deleting a global thread deletes its S3 objects and matching `user_files` rows
- Deleting a workspace thread leaves workspace-chat `user_files` untouched
- The shared scan/upload helper path is exercised by both chat user-file upload and at least one existing non-chat upload flow
