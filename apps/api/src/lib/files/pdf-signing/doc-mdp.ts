/**
 * The modification permission a certified PDF grants (ISO 32000-1 12.8.2.2).
 *
 * A certification signature carries a DocMDP transform whose `P` says what a
 * later revision may change: 1 nothing, 2 form filling and signing, 3 that
 * plus annotations. Appending an approval signature is itself a change, so a
 * document certified with `P = 1` cannot be signed again without breaking the
 * certification.
 */

import { PDF, PdfDict } from "@libpdf/core";
import type { PdfArray, PdfObject, PdfRef } from "@libpdf/core";
import { Result } from "better-result";

import { isSignedPdf } from "@/api/lib/files/pdf-signatures";

export type DocMdpPermission = 1 | 2 | 3;

/** ISO 32000-1 Table 254: an absent `P` means 2. */
const DEFAULT_DOC_MDP_PERMISSION = 2;

const asPermission = (value: number | undefined): DocMdpPermission => {
  if (value === 1 || value === 3) {
    return value;
  }
  // Anything else, including a malformed value, falls back to the default
  // the specification assigns, which is also what viewers enforce.
  return DEFAULT_DOC_MDP_PERMISSION;
};

/** The permission a DocMDP `/Reference` array grants, if it has one. */
const docMdpTransformPermission = (
  references: PdfArray | undefined,
  resolve: (ref: PdfRef) => PdfObject | null,
): DocMdpPermission | null => {
  for (let index = 0; index < (references?.length ?? 0); index += 1) {
    const reference = references?.at(index, resolve);
    if (
      reference instanceof PdfDict &&
      reference.getName("TransformMethod", resolve)?.value === "DocMDP"
    ) {
      return asPermission(
        reference.getDict("TransformParams", resolve)?.getNumber("P", resolve)
          ?.value,
      );
    }
  }
  return null;
};

/**
 * The certification's permission, or `null` for a document that carries no
 * certification signature.
 *
 * A certification is a signature, so an unsigned file (by the shared
 * signed-state check, which also sees signatures a later revision hid) has
 * none. Otherwise the catalog's `/Perms /DocMDP` is where a viewer looks;
 * when a later revision dropped that entry, the signature fields are read
 * for the DocMDP transform the certification carries, since dropping the
 * pointer does not lift what the certification forbids.
 */
export const readDocMdpPermission = ({
  pdf,
  source,
}: {
  pdf: PDF;
  /** The exact bytes `pdf` was loaded from. */
  source: Uint8Array;
}): DocMdpPermission | null => {
  if (!isSignedPdf({ pdf, source })) {
    return null;
  }
  const resolve = (ref: PdfRef): PdfObject | null => pdf.getObject(ref);
  const certification = pdf
    .getCatalog()
    .getDict("Perms", resolve)
    ?.getDict("DocMDP", resolve);
  if (certification) {
    // A catalog entry without a readable transform is still a certification.
    return (
      docMdpTransformPermission(
        certification.getArray("Reference", resolve),
        resolve,
      ) ?? DEFAULT_DOC_MDP_PERMISSION
    );
  }

  // A document without an AcroForm has no signature fields at all.
  const form = pdf.getForm();
  const signatureFields = form ? form.getSignatureFields() : [];
  for (const field of signatureFields) {
    const permission = field.isSigned()
      ? docMdpTransformPermission(
          field.getSignatureDict()?.getArray("Reference", resolve),
          resolve,
        )
      : null;
    if (permission !== null) {
      return permission;
    }
  }
  return null;
};

/**
 * Whether stored PDF bytes carry a certification that forbids any change,
 * checked when signing is requested so the refusal comes before the desktop
 * opens. Bytes LibPDF cannot parse are not refused here: preparing the
 * signature reports them with the reason that applies.
 */
export const certificationForbidsChanges = async (
  bytes: Uint8Array,
): Promise<boolean> => {
  const loaded = await Result.tryPromise(async () => await PDF.load(bytes));
  return (
    Result.isOk(loaded) &&
    readDocMdpPermission({ pdf: loaded.value, source: bytes }) === 1
  );
};
