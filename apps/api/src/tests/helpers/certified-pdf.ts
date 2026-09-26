/**
 * PDFs whose catalog declares a certification signature, for DocMDP tests.
 *
 * Only the structure a viewer reads to decide what a certification permits
 * is built: `/Perms /DocMDP` pointing at a signature dictionary whose
 * `/Reference` carries the DocMDP transform. No signature bytes are needed
 * for that decision.
 */

import { PDF, PdfArray, PdfDict, PdfName, PdfNumber } from "@libpdf/core";

type CertifiedPdfOptions = {
  /** `null` omits `/P`, which the specification reads as 2. */
  permission: number | null;
};

export const buildCertifiedPdf = async ({
  permission,
}: CertifiedPdfOptions): Promise<Uint8Array> => {
  const created = PDF.create();
  created.addPage({ width: 300, height: 400 });
  const loaded = await PDF.load(await created.save());

  const transformParams = PdfDict.of({
    Type: PdfName.of("TransformParams"),
    V: PdfName.of("1.2"),
  });
  if (permission !== null) {
    transformParams.set("P", PdfNumber.of(permission));
  }
  const signature = PdfDict.of({
    Type: PdfName.of("Sig"),
    Filter: PdfName.of("Adobe.PPKLite"),
    SubFilter: PdfName.of("ETSI.CAdES.detached"),
    Reference: new PdfArray([
      PdfDict.of({
        Type: PdfName.of("SigRef"),
        TransformMethod: PdfName.of("DocMDP"),
        TransformParams: transformParams,
      }),
    ]),
  });
  const signatureRef = loaded.context.registry.register(signature);
  loaded.getCatalog().set("Perms", PdfDict.of({ DocMDP: signatureRef }));

  return await loaded.save();
};
