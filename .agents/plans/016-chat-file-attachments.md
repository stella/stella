# 016: Chat File Attachments

## Goal

Allow users to upload external file(s) directly in the chat.
Uploaded files become part of the message context so the model
can reason about them. DOCX files with tracked changes get
special treatment: inline revision markup so the model can
answer questions about redlines.

## File Handling Strategy

| File type                     | Handling                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Images (PNG, JPEG, WEBP, GIF) | `FileUIPart` — native multimodal                                               |
| PDFs                          | `FileUIPart` — native multimodal (all target models support it)                |
| DOCX                          | Extract text server-side with inline tracked changes → system prompt injection |
| Plain text (TXT, CSV, MD)     | Read content directly → system prompt injection                                |

No model capability checks or fallback paths. PDFs are always
sent natively; any model worth using in Stella supports them.

## DOCX Tracked Changes

### Current state

`extract-text.ts` uses `collectText()` which skips `w:del`,
`w:delText`, and `w:moveFrom` elements, producing an
"accepted" view (clean text with all changes applied). The
`ExtractedDocument.view` field is always `"accepted"`.

### New: inline revision markup

For chat context, DOCX extraction produces text with tracked
changes inline. Deletions and insertions are annotated in
place so the model reads the document linearly and sees where
each change sits:

```
The Contractor [DEL by Jane Smith, 2026-03-01: "shall not
exceed"] [INS by Jane Smith, 2026-03-01: "must not exceed"]
the budget allocated for the Project.
```

This requires a new extraction mode that:

1. Walks `w:ins` elements, collecting text from their child
   runs and reading `w:author` + `w:date` attributes
2. Walks `w:del` elements (currently skipped), collecting
   `w:delText` nodes and reading `w:author` + `w:date`
3. Handles `w:moveFrom` / `w:moveTo` pairs (treated as
   delete + insert)
4. Formats each change inline: `[INS by Author, Date: "text"]`
   and `[DEL by Author, Date: "text"]`

The OOXML attributes:

- `w:ins` wraps inserted runs; attributes on the element:
  `w:author`, `w:date`
- `w:del` wraps deleted runs; same attributes. Child runs
  contain `w:delText` instead of `w:t`
- `w:rPrChange` (format changes) are ignored for text context

### displayDocument tool

The model always gets the full tracked-changes version in its
context for reasoning. It also gets a tool to control what the
user sees:

```typescript
displayDocument: tool({
  description:
    "Display the uploaded document to the user in a " +
    "specific view. Use 'simple' for clean accepted text, " +
    "'original' for the pre-edit version, 'tracked-changes' " +
    "for the full redline with annotations.",
  parameters: z.object({
    view: z.enum(["simple", "original", "tracked-changes"]),
    filename: z.string(),
  }),
});
```

| View              | Shows                                      |
| ----------------- | ------------------------------------------ |
| `simple`          | Clean accepted text (all changes accepted) |
| `original`        | Original text (all changes rejected)       |
| `tracked-changes` | Full inline redline with `[INS]`/`[DEL]`   |

The frontend renders this as a formatted document card in the
chat, similar to existing tool call cards. All three views are
generated server-side during extraction and stored in the
processed attachment so the tool can return the right one
without re-processing.

## Architecture

### Upload endpoint

New handler: `apps/api/src/handlers/chat/upload-context-file.ts`

Accepts multipart file upload. Returns processed content
appropriate for the file type.

```typescript
// POST /api/chat/upload-context-file
// Auth: validateAuth (organization-scoped)

// Request: multipart/form-data with a single file

// Response:
type UploadResponse =
  | {
      type: "native-file";
      dataUrl: string; // base64 data URL
      mediaType: string; // e.g. "image/png", "application/pdf"
      filename: string;
    }
  | {
      type: "extracted-text";
      filename: string;
      mediaType: string;
      /** All three views for DOCX; just `simple` for others. */
      views: {
        simple: string;
        original?: string;
        trackedChanges?: string;
      };
    };
```

Flow:

1. Validate file size and MIME type against allowlist
2. Run `scanFile` (YARA rules) — reuse existing pipeline
3. For images/PDFs: convert to base64 data URL, return as
   `native-file`
4. For DOCX: extract text in all three views (accepted,
   original, tracked-changes), return as `extracted-text`
5. For plain text: read content directly, return as
   `extracted-text` with only `simple` view

No persistent S3 storage. Files are processed in memory
and discarded.

### Limits

Add to `apps/api/src/lib/limits.ts`:

```typescript
/** Chat file attachment limits. */
chatContextFileMaxSize: "10m",
chatContextFilesPerMessage: 5,
chatContextTextMaxChars: 32_000,   // total across all files
chatContextFileMaxChars: 16_000,   // per file
```

### Allowed MIME types

Defined as a `Set` constant in the handler:

- `image/png`, `image/jpeg`, `image/webp`, `image/gif`
- `application/pdf`
- `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `text/plain`, `text/csv`, `text/markdown`

### Transport layer

Extend `RivetChatTransport` with a side-channel for processed
attachments (same pattern as plan 010):

```typescript
// rivet-transport.ts

type ProcessedAttachment =
  | {
      type: "native-file";
      dataUrl: string;
      mediaType: string;
      filename: string;
    }
  | {
      type: "extracted-text";
      filename: string;
      views: {
        simple: string;
        original?: string;
        trackedChanges?: string;
      };
    };

class RivetChatTransport {
  pendingAttachments: ProcessedAttachment[] = [];

  sendMessages = async (options) => {
    const attachments = this.pendingAttachments;
    this.pendingAttachments = [];
    // Forward to actor alongside the message
  };
}
```

Update `ChatStreamConnection.sendMessages` input to include
`attachments?: ProcessedAttachment[]`.

### Chat actor

In `sendMessages` action, accept `attachments` and process
before `streamText`:

**Native files** (images, PDFs): inject as `FilePart` in the
last user model message's content array. The AI SDK's
`convertToModelMessages` handles `FileUIPart` in `UIMessage`
parts, but since we're working at the model message level
after conversion, inject directly:

```typescript
const lastUserMsg = modelMessages.findLast((m) => m.role === "user");
if (lastUserMsg) {
  for (const att of nativeAttachments) {
    lastUserMsg.content.unshift({
      type: "file",
      data: new URL(att.dataUrl),
      mediaType: att.mediaType,
    });
  }
}
```

**Extracted text** (DOCX, TXT, CSV, MD): append to the system
prompt. Always inject the richest view (tracked-changes for
DOCX, simple for others):

```
The user has attached these files for context:

--- Contract_v2.docx (tracked changes) ---
The Contractor [DEL by Jane Smith, 2026-03-01: "shall not
exceed"] [INS by Jane Smith, 2026-03-01: "must not exceed"]
the budget allocated for the Project.
---
```

For DOCX, all three views are available in the attachment so
the `displayDocument` tool can return the right one.

**Attachments are ephemeral**: they are NOT persisted in
`thread.messages`. They live in the `backgroundTask` closure
only.

### displayDocument tool

Added to the tool set when text attachments are present:

```typescript
const createDocumentViewTools = (
  attachments: ExtractedTextAttachment[],
): ToolSet => ({
  displayDocument: tool({
    description: "...",
    parameters: z.object({
      view: z.enum(["simple", "original", "tracked-changes"]),
      filename: z.string(),
    }),
    execute: async ({ view, filename }) => {
      const att = attachments.find((a) => a.filename === filename);
      if (!att) return { error: "File not found" };

      const viewKey = view === "tracked-changes" ? "trackedChanges" : view;
      const text = att.views[viewKey] ?? att.views.simple;
      return { filename, view, text };
    },
  }),
});
```

Frontend renders the tool result as a document card with the
formatted text.

## Frontend

### File upload UI

Components:

- **Paperclip button** in `PromptInputFooter` — triggers
  hidden `<input type="file" multiple>`
- **Attachment chips** above the textarea — show pending files
  with remove buttons, loading state during processing
- **Drop zone** overlay on conversation area — drag-and-drop
  support

### Upload flow

1. User selects/drops file(s)
2. Client-side validation (size, MIME type) — fast feedback
3. `POST /api/chat/upload-context-file` per file
4. Show "Extracting content..." chip during processing
5. On success: chip shows filename with remove button
6. On submit: set `transport.pendingAttachments`, call
   `sendMessage()`, clear chips

### Message rendering

For native file parts (images, PDFs), the AI SDK stores them
in `message.parts` as `FileUIPart`. Add rendering for
`part.type === "file"`:

- Images: small thumbnail
- PDFs: filename chip with PDF icon

For `displayDocument` tool results: render as a scrollable
document card with the formatted text, similar to existing
tool call cards.

### Layout

```
┌────────────────────────────────────┐
│ (conversation messages)            │
│                                    │
├────────────────────────────────────┤
│ 📄 Contract.docx ✕  📸 photo.png ✕ │  ← chips
│                                    │
│  [message input area]              │
│                                    │
│ 📎                          [send] │
└────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: DOCX tracked-changes extraction

New extraction mode in `extract-text.ts` (or a sibling
`extract-text-tracked.ts`):

- `collectTextWithRevisions()` — walks the DOM, emitting
  `[INS]`/`[DEL]` annotations inline
- `collectTextOriginal()` — walks the DOM, including
  deleted text and excluding inserted text
- Returns all three views: `simple` (existing), `original`,
  `trackedChanges`

Extend `ExtractedDocument` type or create a new
`ChatExtractedDocument` type with the three views.

### Phase 2: Upload endpoint

- `apps/api/src/handlers/chat/upload-context-file.ts`
- Add limits to `limits.ts`
- Wire into Elysia router
- YARA scanning, MIME validation, size checks

### Phase 3: Transport + actor changes

- `pendingAttachments` on `RivetChatTransport`
- `attachments` input on `sendMessages` action
- System prompt injection for text attachments
- `FilePart` injection for native files
- `displayDocument` tool (conditional, only when DOCX
  attachments present)

### Phase 4: Frontend UI

- Paperclip button, hidden file input
- Attachment chips with loading/remove states
- Drop zone overlay
- `FileUIPart` rendering in messages
- `displayDocument` tool card rendering

### Phase 5: i18n

Add to `en.json` under `chat`:

```json
{
  "chat.attachFile": "Attach file",
  "chat.fileTooLarge": "File exceeds {maxSize} limit",
  "chat.unsupportedFileType": "Unsupported file type",
  "chat.maxAttachmentsReached": "Maximum {count} files per message",
  "chat.uploadFailed": "Failed to process file",
  "chat.extractingContent": "Extracting content...",
  "chat.documentView.simple": "Accepted",
  "chat.documentView.original": "Original",
  "chat.documentView.trackedChanges": "Tracked changes"
}
```

## Security

- **File scanning**: all files pass through `scanFile` (YARA)
  before processing
- **MIME allowlist**: server-side validation; client-side for
  UX only
- **Size limits**: 10 MB/file, 5 files/message; defined in
  `limits.ts`
- **No persistent storage**: files are processed in memory and
  discarded. No S3, no database records
- **Organization-scoped**: validated via session auth; no
  workspace needed
- **Content not logged**: never log file contents or extracted
  text (SOC 2)
- **Subprocess isolation**: DOCX extraction runs in the
  existing sandboxed worker (crash isolation)

## Critical files

| File                                                  | Role                                   |
| ----------------------------------------------------- | -------------------------------------- |
| `apps/api/src/handlers/docx/extract-text.ts`          | Extend with tracked-changes extraction |
| `apps/api/src/handlers/docx/types.ts`                 | Extend types for revision data         |
| `apps/api/src/handlers/chat/upload-context-file.ts`   | New upload endpoint                    |
| `apps/api/src/lib/limits.ts`                          | Add chat attachment limits             |
| `apps/api/src/handlers/registry/actors/chat-actor.ts` | Accept attachments, inject context     |
| `apps/web/src/lib/ai-sdk/rivet-transport.ts`          | `pendingAttachments` side-channel      |
| `apps/web/src/components/right-panel-chat.tsx`        | File upload UI, chips, drop zone       |

## Open questions

1. **Should attachments persist across messages in a thread?**
   Proposed: per-message (cleared after send). Avoids token
   bloat on long conversations. The model can reference
   earlier content via its message history.

2. **Max image size as data URL?** Base64 inflates size ~33%.
   A 10 MB image becomes ~13.3 MB in the data URL. Consider
   capping images at 5 MB to keep payloads reasonable, or
   use a temporary signed S3 URL instead.

3. **Should the upload endpoint stream progress?** For large
   DOCX files, extraction can take seconds. The endpoint
   could return immediately with a job ID and stream
   progress, but that adds complexity. Simpler: just await
   the response with a loading chip on the frontend.
