import JSZip from "jszip";

const MIB = 1024 * 1024;
// Past 32 MiB: more than an in-memory scan of the whole content would hold,
// while keeping the generated fixtures cheap for the test batch.
const LARGE_BYTES = 34 * MIB;
const LETTERS = Buffer.from("abcdefghijklmnopqrstuvwxyz ");
// Park-Miller generator: the product stays below 2^53, so it is exact.
const MINSTD_MULTIPLIER = 48_271;
const MINSTD_MODULUS = 2_147_483_647;

/** Deterministic bytes: `alphabet` letters, or any byte when absent. */
const pseudoRandom = (length: number, alphabet?: Buffer): Buffer => {
  const out = Buffer.alloc(length);
  let state = 1;
  for (let i = 0; i < length; i++) {
    state = (state * MINSTD_MULTIPLIER) % MINSTD_MODULUS;
    out[i] =
      alphabet === undefined
        ? state % 256
        : alphabet.readUInt8(state % alphabet.length);
  }
  return out;
};

const CONTENT_TYPES =
  '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="xml" ContentType="application/xml"/></Types>';

const generate = async (zip: JSZip): Promise<Uint8Array> =>
  await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });

/**
 * A DOCX whose body inflates to `bodyBytes` of prose-like text, with an
 * optional `trailer` written after it, at the end of the part.
 */
export const largeDocx = async ({
  bodyBytes = LARGE_BYTES,
  trailer = "",
}: {
  bodyBytes?: number;
  trailer?: string;
} = {}): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file(
    "word/document.xml",
    Buffer.concat([
      Buffer.from("<w:document><w:body><w:p><w:r><w:t>"),
      pseudoRandom(bodyBytes, LETTERS),
      Buffer.from(`</w:t></w:r></w:p>${trailer}</w:body></w:document>`),
    ]),
  );
  return await generate(zip);
};

/** A DOCX carrying a large stored image, as scanned documents do. */
export const mediaHeavyDocx = async (): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("word/document.xml", "<w:document><w:body/></w:document>");
  zip.file("word/media/image1.jpeg", pseudoRandom(LARGE_BYTES), {
    compression: "STORE",
  });
  return await generate(zip);
};

/** An XLSX whose single sheet inflates far past its compressed size. */
export const largeXlsx = async (): Promise<Uint8Array> => {
  const rows: string[] = [];
  let bytes = 0;
  for (let row = 1; bytes < LARGE_BYTES; row++) {
    const xml =
      `<row r="${row}"><c r="A${row}"><v>${row * 7}</v></c>` +
      `<c r="B${row}" t="s"><v>${row % 977}</v></c></row>`;
    rows.push(xml);
    bytes += xml.length;
  }
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`,
  );
  return await generate(zip);
};

/** A PPTX carrying a large stored video. */
export const mediaHeavyPptx = async (): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("ppt/slides/slide1.xml", "<p:sld><p:cSld/></p:sld>");
  zip.file("ppt/media/media1.mp4", pseudoRandom(LARGE_BYTES), {
    compression: "STORE",
  });
  return await generate(zip);
};
