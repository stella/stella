/**
 * Content of a stored file the upload scan could not read, such as an
 * encrypted file inside a ZIP archive. Everything readable in the file was
 * scanned and nothing found refuses it; only the unreadable content is
 * unscanned, and the file is stored with a scan warning saying why.
 *
 * Scan warnings are stored beside a file as text. The warning for each reason
 * is fixed here, so the scanner that records it and every client that shows
 * it read the same value, and a reason is recovered from a file's warnings by
 * `unscannedContentReasons`, never by matching text elsewhere.
 */

export const UNSCANNED_CONTENT_REASONS = [
  "encrypted",
  "unsupportedCompression",
] as const;

export type UnscannedContentReason = (typeof UNSCANNED_CONTENT_REASONS)[number];

/** The scan warning stored for each reason. */
export const UNSCANNED_CONTENT_WARNING = {
  encrypted: "Some contents are encrypted, so they could not be scanned",
  unsupportedCompression:
    "Some contents use an unsupported compression method, " +
    "so they could not be scanned",
} as const satisfies Record<UnscannedContentReason, string>;

/** The reasons a file's stored scan warnings record, in a fixed order. */
export const unscannedContentReasons = (
  scanWarnings: readonly string[] | null | undefined,
): UnscannedContentReason[] =>
  scanWarnings === null || scanWarnings === undefined
    ? []
    : UNSCANNED_CONTENT_REASONS.filter((reason) =>
        scanWarnings.includes(UNSCANNED_CONTENT_WARNING[reason]),
      );

/**
 * The reasons a client reads from a list the server sent, such as a chat
 * attachment's `unscannedContent`, in the fixed order. A reason this client
 * does not know, from a newer server, is skipped rather than failing the
 * file it belongs to.
 */
export const knownUnscannedContentReasons = (
  value: unknown,
): UnscannedContentReason[] =>
  Array.isArray(value)
    ? UNSCANNED_CONTENT_REASONS.filter((reason) => value.includes(reason))
    : [];
