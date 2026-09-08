import { DOCX_MIME } from "@/lib/consts";

/**
 * Which copy of a file a download hands over. The reference copy is the
 * document with its document reference and verification code in the footer,
 * so a reader outside stella can check what they hold; the original is the
 * bytes exactly as they were uploaded.
 */
export type PrimaryDownloadVariant = "original" | "reference";

type PrimaryDownloadInput = {
  /**
   * Whether the file is encrypted at rest. `undefined` where the caller has
   * not resolved the field yet: the reference copy is built per request from
   * the stored bytes, so an unreadable file reads as ineligible rather than
   * as a download that fails at the click.
   */
  encrypted: boolean | undefined;
  /** Whether the version being downloaded carries a document reference. */
  hasReference: boolean;
  mimeType: string | undefined;
};

/**
 * The single owner of "which variant does the primary Download hand over",
 * shared by the matter row menu and the inspector header so the two entry
 * points cannot drift. Only DOCX qualifies: the reference is written into the
 * document body, which no other format the app serves can carry.
 */
export const resolvePrimaryDownloadVariant = ({
  encrypted,
  hasReference,
  mimeType,
}: PrimaryDownloadInput): PrimaryDownloadVariant =>
  hasReference && encrypted === false && mimeType === DOCX_MIME
    ? "reference"
    : "original";
