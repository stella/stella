import { Result, TaggedError } from "better-result";

/** One document named for a re-check, as the corpus keys it. */
export type RecheckTarget = { jurisdiction: string; documentId: string };

export class CitationProbeRecheckListError extends TaggedError(
  "CitationProbeRecheckListError",
)<{ message: string }> {}

/** Enough to re-read a short residual list, few enough for one run. */
export const MAX_RECHECK_TARGETS = 40;

const RECHECK_ENTRY =
  /^([A-Z]{3}):([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u;

/**
 * Reads `--recheck CZE:<uuid>,SVK:<uuid>`. Every entry must name a full
 * document id: a shortened one would match a different document or none,
 * and a re-check that silently reads another decision proves nothing.
 */
export const parseRecheckTargets = (
  value: string,
): Result<RecheckTarget[], CitationProbeRecheckListError> => {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return Result.err(
      new CitationProbeRecheckListError({
        message: "--recheck needs at least one JURISDICTION:document-id entry",
      }),
    );
  }
  if (entries.length > MAX_RECHECK_TARGETS) {
    return Result.err(
      new CitationProbeRecheckListError({
        message: `--recheck takes at most ${String(MAX_RECHECK_TARGETS)} entries, got ${String(entries.length)}`,
      }),
    );
  }
  const targets: RecheckTarget[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const match = RECHECK_ENTRY.exec(entry);
    const jurisdiction = match?.[1];
    const documentId = match?.[2];
    if (jurisdiction === undefined || documentId === undefined) {
      return Result.err(
        new CitationProbeRecheckListError({
          message: `--recheck entry "${entry}" is not JURISDICTION:full-lowercase-uuid`,
        }),
      );
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      targets.push({ jurisdiction, documentId });
    }
  }
  return Result.ok(targets);
};

/**
 * The text object a document listing points at: the newest `text.zst`.
 * A backfilled document can leave an orphaned content-addressed payload
 * beside the live one; the newest write is the live one in practice, and a
 * superseded payload is still the court's prose.
 */
export const newestTextKey = (
  contents: readonly { key: string; lastModified?: string | undefined }[],
): string | undefined => {
  let newest: { key: string; lastModified?: string | undefined } | undefined;
  for (const entry of contents) {
    if (!entry.key.endsWith("/text.zst")) {
      continue;
    }
    if (
      newest === undefined ||
      (entry.lastModified ?? "") > (newest.lastModified ?? "")
    ) {
      newest = entry;
    }
  }
  return newest?.key;
};
