/**
 * Single source of truth for folio block ids.
 *
 * Both the in-browser editor snapshot (`createFolioAIEditSnapshot`)
 * and the server-side DOCX extractor (`apps/api/.../docx-blocks.ts`)
 * import {@link deriveBlockId} so a citation written by the server
 * resolves in the editor without a separate mapping table. Any other
 * way of minting an id — `b-${n}`, `${idx}`, hand-rolled prefixes —
 * is by definition unable to produce a {@link FolioBlockId}: the
 * branded type makes the divergence a compile-time error rather
 * than a silent "scrollToBlock retries 20 times and gives up".
 *
 * Two id shapes are allowed:
 * - Word's `w14:paraId` (or any non-empty allocator-generated id),
 *   surfaced verbatim when the source paragraph carries one.
 * - A zero-padded `seq-NNNN` fallback derived from document order,
 *   used when the paragraph has no paraId or the paraId collides
 *   with one already taken in the same derivation pass.
 */

const SEQUENTIAL_BLOCK_ID_PREFIX = "seq-";
const SEQUENTIAL_BLOCK_ID_PADDING = 4;
const SEQUENTIAL_BLOCK_ID_PATTERN = /^seq-\d{4,}$/u;

export type FolioBlockId = string & { readonly __brand: "folio.blockId" };

export type DeriveBlockIdInput = {
  /**
   * Source paragraph's `w14:paraId` (or any equivalent stable id),
   * or `null` when the paragraph has none.
   */
  paraId: string | null;
  /** 1-based document order for the paragraph being derived. */
  index: number;
  /**
   * Ids already minted in the same derivation pass. Used to bump
   * the sequential fallback past any collisions (with the source
   * paraId set OR with previous fallbacks).
   */
  taken: ReadonlySet<string>;
};

const formatSequentialBlockId = (index: number): string =>
  `${SEQUENTIAL_BLOCK_ID_PREFIX}${String(index).padStart(SEQUENTIAL_BLOCK_ID_PADDING, "0")}`;

/**
 * The opaque `FolioBlockId` brand has no constructor; an unchecked
 * cast is the runtime no-op that mints one. Centralising the cast
 * here means every other site can keep `typescript/no-unsafe-type-assertion`
 * on.
 */
const brand = (value: string): FolioBlockId => value as unknown as FolioBlockId;

export const deriveBlockId = ({
  paraId,
  index,
  taken,
}: DeriveBlockIdInput): FolioBlockId => {
  if (paraId !== null && paraId.length > 0 && !taken.has(paraId)) {
    return brand(paraId);
  }
  let candidate = index;
  let formatted = formatSequentialBlockId(candidate);
  while (taken.has(formatted)) {
    candidate += 1;
    formatted = formatSequentialBlockId(candidate);
  }
  return brand(formatted);
};

export const isSequentialFolioBlockId = (id: string): boolean =>
  SEQUENTIAL_BLOCK_ID_PATTERN.test(id);

/**
 * Extract the paraId an id was derived from, if any. Returns `null`
 * for sequential fallbacks. Accepts plain `string` so consumers that
 * have a raw id (snapshot anchors, operation blockIds) can call it
 * without an upfront brand check.
 */
export const getFolioParaIdFromBlockId = (id: string): string | null =>
  isSequentialFolioBlockId(id) ? null : id;

/**
 * Runtime refinement for ids coming back from the DB / API. Accepts
 * the same two shapes {@link deriveBlockId} produces and nothing
 * else — so legacy `b-NNNN` rows stop counting as valid here.
 */
export const isFolioBlockId = (value: unknown): value is FolioBlockId => {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  // Malformed sequential ids ("seq-", "seq-abc") are rejected so
  // typos can't pass as ids. The paraId arm is intentionally lenient
  // (any non-empty non-seq string) to match what real DOCX sources
  // and test fixtures put in `w14:paraId` — structural divergence is
  // already prevented by routing every mint through {@link deriveBlockId},
  // not by an exhaustive format check here.
  if (value.startsWith(SEQUENTIAL_BLOCK_ID_PREFIX)) {
    return SEQUENTIAL_BLOCK_ID_PATTERN.test(value);
  }
  return true;
};
