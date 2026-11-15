import { PDF, StandardFonts } from "@libpdf/core";

const LETTERS = Buffer.from("abcdefghijklmnopqrstuvwxyz ");

/**
 * A baseline JPEG whose entropy-coded data is `scanBytes` of letters. A PDF
 * stores a JPEG as-is, so the image sets the file's size the way a scanned
 * page does, and its bytes never form a JPEG marker (no 0xFF).
 */
const scannedPageJpeg = (scanBytes: number): Uint8Array => {
  const header = Uint8Array.from([
    // SOI
    0xff, 0xd8,
    // SOF0: 8-bit samples, 1 x 1 pixels, one component
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
    0x00,
    // SOS: one component, then the scan data
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  ]);
  const scan = Buffer.alloc(scanBytes);
  for (let index = 0; index < scanBytes; index += 1) {
    scan[index] = LETTERS.readUInt8(index % LETTERS.length);
  }
  return Buffer.concat([header, scan, Uint8Array.from([0xff, 0xd9])]);
};

/**
 * A one-page PDF of at least `minBytes`, as a scanned bundle is: one large
 * page image under a line of real text, so a reader still finds `text`.
 */
export const largeScannedPdf = async ({
  minBytes,
  text,
}: {
  minBytes: number;
  text: string;
}): Promise<Uint8Array> => {
  const pdf = PDF.create();
  const page = pdf.addPage({ width: 612, height: 792 });
  page.drawImage(pdf.embedJpeg(scannedPageJpeg(minBytes)), {
    x: 0,
    y: 0,
    width: 612,
    height: 700,
  });
  page.drawText(text, {
    x: 72,
    y: 740,
    size: 18,
    font: StandardFonts.Helvetica,
  });
  return await pdf.save();
};
