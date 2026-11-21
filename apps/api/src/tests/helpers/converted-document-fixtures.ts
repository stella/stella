/**
 * Synthetic files of the formats documents are converted from, built from
 * their specifications: content only, no third-party sample.
 */
import { ZipArchive } from "@stll/docx-core/zip";

import { buildCompoundFile } from "@/api/lib/files/compound-file.test-fixture";

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * A WordPerfect 5.1 document: the 16-byte prefix (signature, a pointer to
 * the text at offset 16, product 1 = WordPerfect, file type 10 = document,
 * version 0.1, unencrypted), then the paragraphs as text, each ended by a
 * hard return.
 */
export const wordPerfectFile = (paragraphs: readonly string[]): Uint8Array => {
  const prefix = new Uint8Array(16);
  prefix.set([0xff, 0x57, 0x50, 0x43]);
  new DataView(prefix.buffer).setUint32(4, prefix.byteLength, true);
  prefix.set([1, 10, 0, 1], 8);
  const text = encode(paragraphs.map((paragraph) => `${paragraph}\n`).join(""));
  const file = new Uint8Array(prefix.byteLength + text.byteLength);
  file.set(prefix);
  file.set(text, prefix.byteLength);
  return file;
};

/** A compound file holding one empty top-level stream per name. */
export const compoundFileWithStreams = (names: readonly string[]): Uint8Array =>
  buildCompoundFile(
    names.map((name) => ({ path: [name], bytes: new Uint8Array(8) })),
  );

/** A ZIP package with the given entries. */
export const packageOf = async (
  entries: Readonly<Record<string, string | Uint8Array>>,
): Promise<Uint8Array> => {
  const archive = new ZipArchive();
  for (const [path, value] of Object.entries(entries)) {
    archive.set(path, typeof value === "string" ? encode(value) : value);
  }
  return await archive.generate({ compression: "store" });
};

/** The package relationships naming `target` as the office document. */
export const ooxmlRelationships = (target: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;

/** An OOXML package whose main part has `mainContentType`. */
export const ooxmlPackage = async (
  mainContentType: string,
  extra: Readonly<Record<string, string | Uint8Array>> = {},
): Promise<Uint8Array> =>
  await packageOf({
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/main.xml" ContentType="${mainContentType}"/></Types>`,
    "_rels/.rels": ooxmlRelationships("main.xml"),
    "main.xml": "<main/>",
    ...extra,
  });

/** An OpenDocument package declaring `mimeType`. */
export const odfPackage = async (
  mimeType: string,
  extra: Readonly<Record<string, string>> = {},
): Promise<Uint8Array> =>
  await packageOf({
    mimetype: mimeType,
    "META-INF/manifest.xml": "<manifest/>",
    "content.xml": "<content/>",
    ...extra,
  });

/** An iWork package (Pages, Numbers or Keynote) of the current format. */
export const iworkPackage = async (
  extra: Readonly<Record<string, string>> = {},
): Promise<Uint8Array> =>
  await packageOf({
    "Index/Document.iwa": "iwa",
    "Metadata/Properties.plist": "<plist/>",
    ...extra,
  });

const IWORK_09_NAMESPACES =
  'xmlns:sfa="http://developer.apple.com/namespaces/sfa" xmlns:sf="http://developer.apple.com/namespaces/sf"';

/** A Pages '09 document: its XML index, one text-body paragraph per entry. */
export const pages09File = async (
  paragraphs: readonly string[],
): Promise<Uint8Array> =>
  await packageOf({
    "index.xml": `<?xml version="1.0"?><sl:document ${IWORK_09_NAMESPACES} xmlns:sl="http://developer.apple.com/namespaces/sl" sl:version="92008102400"><sf:text-storage sf:kind="body"><sf:text-body>${paragraphs
      .map((paragraph) => `<sf:p>${paragraph}<sf:br/></sf:p>`)
      .join("")}</sf:text-body></sf:text-storage></sl:document>`,
  });

/** A Numbers '09 spreadsheet: one sheet, one table of label and amount rows. */
export const numbers09File = async (
  rows: readonly (readonly [label: string, amount: number])[],
): Promise<Uint8Array> => {
  const cells = rows
    .map(
      ([label, amount]) =>
        `<sf:t><sf:ct sfa:s="${label}"/></sf:t><sf:n sf:v="${amount}"/>`,
    )
    .join("");
  const gridRows = rows.map(() => '<sf:grid-row sf:height="18"/>').join("");
  return await packageOf({
    "index.xml": `<?xml version="1.0"?><ls:document ${IWORK_09_NAMESPACES} xmlns:ls="http://developer.apple.com/namespaces/ls" ls:version="92008102400"><ls:workspace-array><ls:workspace ls:workspace-name="Sheet 1"><ls:page-info><sf:layers><sf:layer><sf:drawables><sf:tabular-info><sf:tabular-model sf:name="Table 1" sf:num-header-rows="0" sf:num-header-columns="0"><sf:grid sf:numcols="2" sf:numrows="${rows.length}"><sf:columns sf:count="2"><sf:grid-column sf:width="96"/><sf:grid-column sf:width="72"/></sf:columns><sf:rows sf:count="${rows.length}">${gridRows}</sf:rows><sf:datasource>${cells}</sf:datasource></sf:grid></sf:tabular-model></sf:tabular-info></sf:drawables></sf:layer></sf:layers></ls:page-info></ls:workspace></ls:workspace-array></ls:document>`,
  });
};

/**
 * A baseline TIFF (little endian, uncompressed 8-bit RGB) with one image
 * file directory per page, each page a solid colour.
 */
export const multiPageTiff = (
  colours: readonly (readonly [red: number, green: number, blue: number])[],
  width = 40,
  height = 30,
): Uint8Array => {
  const tags = 10;
  const directoryBytes = 2 + tags * 12 + 4;
  const pixelBytes = width * height * 3;
  // Each page: its directory, its BitsPerSample values, then its pixels.
  const pageBytes = directoryBytes + 6 + pixelBytes;
  const file = new Uint8Array(8 + colours.length * pageBytes);
  const view = new DataView(file.buffer);
  file.set([0x49, 0x49]);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  for (const [page, [red, green, blue]] of colours.entries()) {
    const start = 8 + page * pageBytes;
    const bitsAt = start + directoryBytes;
    const pixelsAt = bitsAt + 6;
    const entries: readonly (readonly [number, number, number, number])[] = [
      [256, 4, 1, width],
      [257, 4, 1, height],
      [258, 3, 3, bitsAt],
      [259, 3, 1, 1],
      [262, 3, 1, 2],
      [273, 4, 1, pixelsAt],
      [277, 3, 1, 3],
      [278, 4, 1, height],
      [279, 4, 1, pixelBytes],
      [284, 3, 1, 1],
    ];
    view.setUint16(start, tags, true);
    for (const [index, [tag, type, count, value]] of entries.entries()) {
      const at = start + 2 + index * 12;
      view.setUint16(at, tag, true);
      view.setUint16(at + 2, type, true);
      view.setUint32(at + 4, count, true);
      if (type === 3 && count === 1) {
        view.setUint16(at + 8, value, true);
      } else {
        view.setUint32(at + 8, value, true);
      }
    }
    const next = page + 1 < colours.length ? start + pageBytes : 0;
    view.setUint32(start + 2 + tags * 12, next, true);
    for (let sample = 0; sample < 3; sample++) {
      view.setUint16(bitsAt + sample * 2, 8, true);
    }
    for (let pixel = 0; pixel < width * height; pixel++) {
      file.set([red, green, blue], pixelsAt + pixel * 3);
    }
  }
  return file;
};
