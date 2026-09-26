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
import type { PdfObject, PdfRef } from "@libpdf/core";

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

/**
 * The certification's permission, or `null` for a document that carries no
 * certification signature.
 *
 * Read from the catalog's `/Perms /DocMDP` entry, which is where a viewer
 * looks: a certification signature is the one the catalog points at, not
 * any signature that happens to carry a DocMDP reference.
 */
export const readDocMdpPermission = (pdf: PDF): DocMdpPermission | null => {
  const resolve = (ref: PdfRef): PdfObject | null => pdf.getObject(ref);
  const certification = pdf
    .getCatalog()
    .getDict("Perms", resolve)
    ?.getDict("DocMDP", resolve);
  if (!certification) {
    return null;
  }

  const references = certification.getArray("Reference", resolve);
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
  // A catalog entry without a readable transform is still a certification.
  return DEFAULT_DOC_MDP_PERMISSION;
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
  let pdf: PDF;
  try {
    pdf = await PDF.load(bytes);
  } catch {
    return false;
  }
  return readDocMdpPermission(pdf) === 1;
};
