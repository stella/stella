# Plan: Image Thumbnails + Thumbhash Derivatives

Date: 2026-06-06

## Goal

Generate a small WebP thumbnail and a thumbhash placeholder string for
uploaded image files using the built-in `Bun.Image` API (Bun 1.3.14), so the
UI can render real, legible image previews with instant blur-up placeholders
instead of a generic file-type icon. Originals are never altered.

## Design Decisions

- **Async derivative job, not inline at finalize.** Mirror the existing PDF
  derivative pattern (`apps/api/src/lib/file-derivative-queue.ts`): finalize
  stays fast, generation runs on the BullMQ worker, the UI invalidates via SSE
  when the derivative is ready. We do *not* block `finalize.ts` on image
  encoding. Rationale: same failure isolation, retry, and backpressure the PDF
  path already proved; avoids regressing upload latency.
- **Reuse the `file-derivatives` queue, add a second job type.** The queue and
  worker infra already exist; add a `generate-thumbnail` job alongside
  `generate-pdf` rather than standing up a parallel queue. One worker, two job
  names, shared connection/concurrency config.
- **Thumbhash stored inline in JSONB; thumbnail stored as a separate S3
  object.** Thumbhash is a tiny (~25–30 byte) base64 string — it lives directly
  in the `file` variant of `FieldContent` so it ships with the entity payload
  and needs zero extra fetch to render the blur. The thumbnail WebP is a real
  image binary, so it gets its own `fileId` + S3 key, referenced the same way
  `pdfFileId` references the PDF derivative.
- **`Bun.Image` over any native dep.** Zero install, already on Bun 1.3.14
  (`oven/bun:1.3.14-slim`). Statically-linked codecs cover exactly our accepted
  formats. No Sharp/Jimp to add or maintain.
- **Linux-safe format gating.** Only `image/png`, `image/jpeg`, `image/webp`,
  `image/gif` are eligible — these use Bun's statically-linked codecs that
  decode identically on Linux prod. HEIC/AVIF/TIFF only decode on macOS/Windows
  and would silently fail in prod, so they are explicitly excluded from the
  eligibility check (and we don't accept them on upload today anyway).
- **`placeholder()` gives a rendered PNG data URL, not a raw hash.**
  `Bun.Image.placeholder()` returns a ThumbHash-rendered
  `data:image/png;base64,…` (~400–700 bytes, ≤32px blur). We store that string
  directly — the frontend drops it into `<img src>` / a CSS background with
  **zero client-side decoder dependency**. No `thumbhash`/`blurhash` npm package.
- **Force `Bun.Image.backend = "bun"` in the worker.** Static-codec mode is
  byte-identical to the Linux build and makes HEIC/AVIF reject consistently, so
  dev (macOS) output matches prod (Linux) and unsupported formats fail the same
  way everywhere instead of silently succeeding on a Mac.
- **Icon stays at tiny sizes; thumbnail only where legible.** The
  icon-vs-thumbnail decision is gated by render size, not blanket-applied.
  Surfaces at `size-3`/`size-4` (12–16px) keep the generic `FileImage` icon (a
  blur/thumbnail is illegible there). Surfaces ≥ ~24px opt into the real
  thumbnail + thumbhash placeholder.

## Scope

**In scope:**

- New eligibility helper `shouldGenerateImageThumbnail({ encrypted, mimeType })`
  parallel to `shouldGeneratePdfDerivative` (excludes encrypted + non-Linux-safe
  formats).
- `Bun.Image` thumbnail generation (resize to fit a bounded box, e.g. longest
  edge ~512px, `withoutEnlargement`, WebP output) + `.placeholder()` thumbhash,
  in a new `generate-thumbnail` worker job.
- **Entity-file path (JSONB).** Add `thumbnailFileId`, `placeholder` (the
  data-URL string from `.placeholder()`), and a `thumbnailDerivative` status
  union (`not-required`/`pending`/`ready`/`failed`) to the `file` content
  variant, mirroring `pdfDerivative`. Enqueue at finalize; backfill existing
  rows.
- **Chat-file path (`userFiles` table).** Add `thumbnail_file_id` +
  `placeholder` columns to the `user_files` table (real Drizzle migration), a
  thumbnail content endpoint, generation on chat upload, and read-path
  enrichment so the message attachment carries the placeholder + thumbnail URL.
  Backfill existing `user_files` image rows.
- Single 512px-longest-edge WebP thumbnail per image (no multi-size set).
- Batched backfill enqueue for both paths (worker concurrency + retry absorbs
  it); log/monitor queue depth.
- Frontend: a `<FilePreview>` that renders the thumbnail with the `placeholder`
  data URL as the blur-up, wired into the size-appropriate surfaces (search
  results, file tree, inspector tabs; chat 128px attachments). Tiny chip/cell
  surfaces (12–16px) keep `DocumentIcon`.
- Cleanup: deleting a file field / user file also deletes its thumbnail S3
  object (extend the existing sweep that handles `pdfFileId`).

**Out of scope:**

- Re-encoding or replacing originals (originals stay byte-identical).
- HEIC/AVIF/TIFF support (Linux can't decode; not accepted on upload).
- A new gallery/grid view (the highest-value consumer, but its own feature).
- Animated-GIF motion thumbnails (we take the first frame only).
- Multi-resolution thumbnails (single 512px for now; revisit if a gallery lands).

## Implementation

- `apps/api/src/handlers/files/gotenberg.ts` (or a new
  `apps/api/src/handlers/files/image-derivative.ts`) — add
  `IMAGE_THUMBNAIL_MIME_TYPES` (the 4 Linux-safe formats) and
  `shouldGenerateImageThumbnail`. Keep image-thumbnail logic separate from the
  PDF/gotenberg concern if it grows.
- `apps/api/src/handlers/files/image-derivative.ts` (new) — the shared
  `Bun.Image` helper: `IMAGE_THUMBNAIL_MIME_TYPES`, `shouldGenerateImageThumbnail`,
  and `generateImageThumbnail(buffer)` returning `{ webp, placeholder }`. Sets
  `Bun.Image.backend = "bun"` for Linux-parity; wraps the pipeline in `Result`.
  Single 512px longest-edge, `withoutEnlargement`, `webp({ quality })`.

**Entity-file path:**

- `apps/api/src/lib/file-derivative-queue.ts` — add `ImageThumbnailJobData`, a
  `generate-thumbnail` job name, `enqueueImageThumbnail`, and
  `processImageThumbnailJob` that loads the field, reads the source from S3,
  runs `generateImageThumbnail`, writes the WebP to a new file key, and
  atomically patches the JSONB content (`thumbnailFileId`, `placeholder`,
  `thumbnailDerivative.status='ready'`) with the same optimistic `WHERE` guards
  the PDF path uses. Broadcast the same `invalidate-query` SSE events.
- `apps/api/src/handlers/uploads/finalize.ts` / per-purpose entity finalizers —
  enqueue `generate-thumbnail` for eligible image fields next to the PDF enqueue.
- `apps/api/src/db/schema-validators.ts` (lines ~131–158, `file` variant) — add
  `thumbnailFileId: t.Nullable(...)`, `placeholder: t.Optional(t.String({ maxLength: 2048 }))`,
  `thumbnailDerivative: t.Optional(t.Union([...]))`. Additive + optional → no
  data migration; existing rows read fine.
- `apps/api/src/handlers/files/utils.ts` — thumbnail key reuses `createFileKey`
  with the thumbnail's own `fileId` + `image/webp`; extend the S3 delete sweep
  to include `thumbnailFileId`.

**Chat-file path:**

- `apps/api/src/db/schema.ts` (`userFiles`, lines ~3223–3258) — add
  `thumbnailFileId text` + `placeholder text` columns. **Hand-authored
  timestamped Drizzle migration** per project convention (never `drizzle-kit
  generate`).
- `apps/api/src/handlers/chat/upload-files.ts` (`uploadUserFile`) — after the
  `userFiles` insert, enqueue a `generate-thumbnail` job variant keyed by
  `userFileId` (or generate inline if simpler) that writes
  `${userId}/${thumbnailFileId}.webp` and patches the row.
- `apps/api/src/handlers/user-files/read-content.ts` (+ routes) — add a
  `GET /user-files/:fileId/thumbnail` redirect parallel to `/content`, resolving
  `thumbnailFileId` → presigned URL with the same ownership scoping.
- Chat thread read path — enrich the persisted `FileUIPart` on the way out with
  the attachment's `placeholder` + thumbnail URL (join `userFiles`) so the
  frontend can render the blur + thumbnail without a separate metadata call.

**Backfill:**

- One-off batched scripts (under `apps/api/scripts/`): scan `fields`
  (`type='file'` images lacking `thumbnailDerivative`) and `user_files` (image
  rows with null `thumbnailFileId`) and enqueue jobs in batches; log queue depth.

**Frontend:**

- `apps/web/.../-components/document-icon.tsx` (line 140 chokepoint) — keep
  `FileImage` for tiny sizes; introduce a sibling `FilePreview` that takes
  `{ mimeType, thumbnailUrl, placeholder }` + a size hint and renders the
  thumbnail with the `placeholder` data URL as the blur-up (plain `<img src>` /
  CSS background, **no decoder dependency**). Callers at 12–16px stay on
  `DocumentIcon`; larger surfaces opt in.
- `apps/web/src/components/chat/chat-thread-messages.tsx` (lines 175–221) — use
  the enriched `placeholder` as the 128px image's blur-up, and point `src` at
  the thumbnail URL (fall back to full `/content` on error).

## Test Cases

- `shouldGenerateImageThumbnail`: true for the 4 Linux-safe formats unencrypted;
  false for encrypted, for HEIC/AVIF/TIFF, and for non-image mimes.
- Thumbnail job: produces a WebP within the bounded box, does not enlarge a
  small source, sets `thumbnailDerivative='ready'`, populates `thumbhash`, and
  the optimistic `WHERE` no-ops on a concurrent/duplicate run (mirror the PDF
  job's idempotency test).
- `placeholder` data-URL round-trips through the schema validator / DB column
  and renders directly in an `<img src>` with no client decoder.
- Deleting a file field / user file also deletes the thumbnail object (no
  orphaned S3 keys).
- Frontend: thumbnail renders at large surfaces; `DocumentIcon` (generic icon)
  still renders at 12–16px surfaces; missing/failed derivative falls back to the
  generic icon without layout shift.
- Corrupt/truncated image bytes: job fails cleanly, marks
  `thumbnailDerivative='failed'` (entity) / leaves null (chat), original remains
  downloadable.
- Chat: `user_files` migration applies cleanly; thumbnail endpoint enforces the
  same `userId` ownership scoping as `/content`.

## Resolved Decisions

- **Single 512px WebP** (no multi-size set).
- **Chat folded in now** (`user_files` columns + thumbnail endpoint + read-path
  enrichment), not deferred. Chat is the one ≥24px surface today (128px
  attachment), so it is the only wired consumer.
- **Batched backfill enqueue** for both paths; monitor queue depth.
- **Entity-file frontend deferred.** Every current entity surface that renders a
  file icon is 12–16px, where the agreed guidance keeps the generic icon. No
  ≥24px entity surface exists yet (no gallery / large file cards), so there is
  nowhere legible to show an entity thumbnail. A generic photo gallery is niche
  for legal work; the real future consumer is a file-list grid/card density for
  document/scan recognition and image-heavy matters (PI, property, IP).
- **Entity-file generation kept dormant.** The async job stays wired at all
  upload sites so images get thumbnails now; a future grid/card surface lands
  with thumbnails already populated. The `FilePreview` component + entity
  thumbnail-serving endpoint are intentionally NOT built yet — add them when the
  surface is greenlit.

## Open Questions

- Animated GIF: confirm `Bun.Image` takes frame 0 deterministically for our
  inputs; if not, gate GIF behind a flag.
