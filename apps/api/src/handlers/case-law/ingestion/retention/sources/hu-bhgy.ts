/**
 * Retention projection for the Hungarian court decision collection.
 *
 * The adapter stores the listing row and the decision file in one envelope:
 * the file under `document`, base64 because it is binary, and the format
 * it was classified as under `documentContentType`. The collection serves two
 * eras of file, a current Word package and a legacy RTF (often under a
 * `.docx` name), so the format is read off the bytes' own signature, as the
 * stored type could only repeat what the adapter concluded.
 *
 * The projection is the file's paragraphs, body and notes, read by this
 * module's own readers. A listing stored without its file is a decision whose
 * text the publisher did not serve.
 */
import {
  RETENTION_PROJECTION_FAILURE,
  RETENTION_TEXT_ABSENCE,
  type RetentionPolicy,
  type RetentionProjection,
} from "@/api/handlers/case-law/ingestion/retention/retention-policy";
import { docxParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/docx-paragraphs";
import { rtfParagraphs } from "@/api/handlers/case-law/ingestion/retention/sources/rtf-paragraphs";
import { decodeSourceRawEnvelope } from "@/api/lib/legal-search/source-raw-envelope";

/** The envelope part the decision file is stored under, base64. */
const DOCUMENT_PART = "document";

/** The first bytes of a ZIP local file header, which a Word package opens with. */
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;

const projectHuBhgy = (sourceRaw: string): RetentionProjection => {
  const parts = decodeSourceRawEnvelope(sourceRaw);
  if (parts === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_ENVELOPE,
    };
  }
  const encoded = parts[DOCUMENT_PART];
  if (encoded === undefined) {
    return { type: "no-text", reason: RETENTION_TEXT_ABSENCE.NOT_PUBLISHED };
  }
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
  const paragraphs = ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte)
    ? docxParagraphs(bytes)
    : rtfParagraphs(bytes);
  if (paragraphs === null) {
    return {
      type: "unreadable",
      reason: RETENTION_PROJECTION_FAILURE.UNREADABLE_DOCUMENT,
    };
  }
  return { type: "source", source: { type: "paragraphs", paragraphs } };
};

export const huBhgyRetention = {
  type: "checked",
  project: async (sourceRaw) => await Promise.resolve(projectHuBhgy(sourceRaw)),
} as const satisfies RetentionPolicy;
