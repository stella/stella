/**
 * The one place server code writes PDF bytes that a person will keep.
 *
 * A digital signature covers the exact bytes of the revision it was made over.
 * A full save renumbers and re-encodes every object, so the covered ranges no
 * longer hash to what was signed. An appended update keeps those bytes, but a
 * validator still reports page content added after signing as a modification,
 * and no certification level permits it. So a signed PDF is never rewritten:
 * callers keep the stored original and put derived data somewhere else.
 *
 * Encrypted input is left alone too: a rewrite would either need the password
 * or silently change the document's protection.
 */

import type { PDF, SaveOptions } from "@libpdf/core";
import { TaggedError } from "better-result";

/** An appended revision was asked for where only a rewrite is possible. */
export class PdfRevisionAppendError extends TaggedError(
  "PdfRevisionAppendError",
)<{ blocker: string; message: string }> {}

/**
 * Name tokens that only a signature (or a certification pointing at one) puts
 * into a file. `/ByteRange` sits in every signature dictionary, including
 * document timestamps, and those dictionaries are never compressed into object
 * streams: their /Contents must be left out of the signed bytes in place.
 */
const SIGNATURE_NAMES = new Set(["ByteRange", "DocMDP"]);

// A PDF name token: a slash, then regular characters or #xx escapes.
const ESCAPED_NAME =
  /\/((?:[^\s/<>[\]()%{}#]|#[\da-f]{2})*#[\da-f]{2}(?:[^\s/<>[\]()%{}#]|#[\da-f]{2})*)/giu;

const decodeName = (name: string) =>
  name.replaceAll(/#([\da-f]{2})/giu, (_, hex: string) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );

/**
 * Whether the raw file carries a signature in any revision. A later revision
 * can remove the field, move its /V onto an inherited parent, or drop SigFlags,
 * none of which unsigns the earlier bytes, so this reads the source itself
 * rather than the current form. A stray match only keeps a file unchanged.
 */
const rawBytesCarrySignature = (source: Uint8Array): boolean => {
  const text = Buffer.from(
    source.buffer,
    source.byteOffset,
    source.byteLength,
  ).toString("latin1");
  for (const name of SIGNATURE_NAMES) {
    if (text.includes(`/${name}`)) {
      return true;
    }
  }
  for (const match of text.matchAll(ESCAPED_NAME)) {
    if (SIGNATURE_NAMES.has(decodeName(match[1] ?? ""))) {
      return true;
    }
  }
  return false;
};

type PdfSource = {
  pdf: PDF;
  /** The exact bytes `pdf` was loaded from. */
  source: Uint8Array;
};

/**
 * Whether the PDF has, or ever had, a signature. Conservative by design: a
 * false positive keeps a file unchanged, a false negative breaks a signature.
 */
export const isSignedPdf = ({ pdf, source }: PdfSource): boolean =>
  pdf.getForm()?.properties.hasSignatures === true ||
  rawBytesCarrySignature(source);

export type PdfRewriteBlocker = "encrypted" | "signed";

/** Why `pdf` must not be rewritten, or null when a full save is safe. */
export const findPdfRewriteBlocker = ({
  pdf,
  source,
}: PdfSource): PdfRewriteBlocker | null => {
  if (pdf.isEncrypted) {
    return "encrypted";
  }
  return isSignedPdf({ pdf, source }) ? "signed" : null;
};

export type SavePdfRewriteResult =
  | { status: "saved"; bytes: Uint8Array }
  | { status: PdfRewriteBlocker };

/**
 * Fully rewrites `pdf`, or answers why it must stay as `source` is. Callers
 * refuse the operation or keep `source`; they never fall back to another save.
 */
export const savePdfRewrite = async ({
  pdf,
  source,
  options = {},
}: PdfSource & {
  options?: Omit<SaveOptions, "incremental">;
}): Promise<SavePdfRewriteResult> => {
  const blocker = findPdfRewriteBlocker({ pdf, source });
  if (blocker !== null) {
    return { status: blocker };
  }
  return { status: "saved", bytes: await pdf.save(options) };
};

/**
 * Appends a signing revision: the incremental update a signature, and the
 * validation data that goes with it, is written as. Nothing already in the
 * file is rewritten, so every earlier signature keeps covering its bytes;
 * this is the one save that is meant for a signed PDF, and the signing
 * pipeline is its only caller.
 */
export const appendSigningRevision = async (pdf: PDF): Promise<Uint8Array> => {
  // LibPDF quietly falls back to a full rewrite when it cannot append (a
  // pending encryption change, a linearized or repaired file). For a signed
  // file that rewrite is exactly what this helper exists to prevent.
  const blocker = pdf.canSaveIncrementally();
  if (blocker !== null) {
    throw new PdfRevisionAppendError({
      blocker,
      message: `This PDF cannot take an appended revision (${blocker}).`,
    });
  }
  return await pdf.save({ incremental: true });
};

/**
 * Serialises a transient copy that only ever goes to a model as input (a
 * Bates-stamped document, a single extracted page). Its bytes are never stored
 * or handed to a person, so the signature rules above do not apply.
 */
export const savePdfForModelInput = async (pdf: PDF): Promise<Uint8Array> =>
  await pdf.save();
