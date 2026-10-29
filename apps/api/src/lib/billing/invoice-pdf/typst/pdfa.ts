import {
  PDF,
  PdfArray,
  PdfDict,
  PdfName,
  PdfNumber,
  PdfRef,
  PdfStream,
  PdfString,
} from "@libpdf/core";
import { panic } from "better-result";

import { savePdfRewrite } from "@/api/lib/files/pdf-signatures";

import srgbProfilePath from "./icc/sRGB-v2-micro.icc" with { type: "file" };

/** How an embedded file relates to the visible document (ISO 32000-2 / PDF/A-3). */
type AttachmentRelationship = "Source" | "Data" | "Alternative" | "Supplement";

export type PdfA3Attachment = {
  name: string;
  bytes: Uint8Array;
  mimeType: string;
  description: string;
  relationship: AttachmentRelationship;
};

type PdfA3Options = {
  title: string;
  lang: string;
  /** Fixed so the same snapshot always produces the same metadata. */
  createdAt: Date;
  attachments: PdfA3Attachment[];
};

export const PDFA_PRODUCER = "stella";
const PDFA_CREATOR_TOOL = "stella invoice renderer (Typst)";

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// XMP dates must equal the Info dictionary dates; both are written in UTC.
const xmpDate = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/u, "Z");

const xmpPacket = ({ title, lang, createdAt }: PdfA3Options) => {
  const when = xmpDate(createdAt);
  return `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"
    xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdfaid:part>3</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(title)}</rdf:li></rdf:Alt></dc:title>
   <dc:language><rdf:Bag><rdf:li>${escapeXml(lang)}</rdf:li></rdf:Bag></dc:language>
   <xmp:CreatorTool>${PDFA_CREATOR_TOOL}</xmp:CreatorTool>
   <xmp:CreateDate>${when}</xmp:CreateDate>
   <xmp:ModifyDate>${when}</xmp:ModifyDate>
   <xmp:MetadataDate>${when}</xmp:MetadataDate>
   <pdf:Producer>${PDFA_PRODUCER}</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
};

const findFileSpec = (pdf: PDF, name: string): PdfRef => {
  const catalog = pdf.getCatalog();
  const names = catalog.getDict("Names", (ref) => pdf.getObject(ref));
  const tree = names?.getDict("EmbeddedFiles", (ref) => pdf.getObject(ref));
  const entries = tree?.getArray("Names", (ref) => pdf.getObject(ref));
  if (entries === undefined) {
    return panic("Embedded file tree is missing after adding an attachment");
  }
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const key = entries.at(index);
    const value = entries.at(index + 1);
    if (
      key instanceof PdfString &&
      key.asString() === name &&
      value instanceof PdfRef
    ) {
      return value;
    }
  }
  return panic(`Attachment ${name} is not referenced by the name tree`);
};

/**
 * Turns a Typst PDF into a PDF/A-3b candidate: XMP identification and
 * metadata matching the Info dictionary, an sRGB output intent, and embedded
 * files declared as associated files. Typst already embeds every font and
 * writes a file identifier.
 */
export const toPdfA3 = async (source: Uint8Array, options: PdfA3Options) => {
  const pdf = await PDF.load(source);
  const register = (object: PdfDict | PdfStream) =>
    pdf.context.registry.register(object);
  const catalog = pdf.getCatalog();

  pdf.setMetadata({
    title: options.title,
    creator: PDFA_CREATOR_TOOL,
    producer: PDFA_PRODUCER,
    creationDate: options.createdAt,
    modificationDate: options.createdAt,
    language: options.lang,
  });

  catalog.set(
    "Metadata",
    register(
      new PdfStream(
        PdfDict.of({
          Type: PdfName.of("Metadata"),
          Subtype: PdfName.of("XML"),
        }),
        new TextEncoder().encode(xmpPacket(options)),
      ),
    ),
  );

  const profile = new Uint8Array(await Bun.file(srgbProfilePath).arrayBuffer());
  catalog.set(
    "OutputIntents",
    PdfArray.of(
      register(
        PdfDict.of({
          Type: PdfName.of("OutputIntent"),
          S: PdfName.of("GTS_PDFA1"),
          OutputConditionIdentifier: PdfString.fromString("sRGB IEC61966-2.1"),
          Info: PdfString.fromString("sRGB IEC61966-2.1"),
          DestOutputProfile: register(
            new PdfStream(PdfDict.of({ N: PdfNumber.of(3) }), profile),
          ),
        }),
      ),
    ),
  );

  const associated: PdfRef[] = [];
  for (const attachment of options.attachments) {
    pdf.attachments.add(attachment.name, attachment.bytes, {
      description: attachment.description,
      mimeType: attachment.mimeType,
      createdAt: options.createdAt,
      modifiedAt: options.createdAt,
    });
    const ref = findFileSpec(pdf, attachment.name);
    const spec = pdf.getObject(ref);
    if (!(spec instanceof PdfDict)) {
      return panic("Attachment file specification is not a dictionary");
    }
    spec.set("AFRelationship", PdfName.of(attachment.relationship));
    // LibPDF writes the MIME subtype with its slash escaped twice
    // (`application#232Fxml`); PDF/A-3 rule 6.8-1 needs a valid MIME name.
    const file = spec
      .getDict("EF", (value) => pdf.getObject(value))
      ?.get("F", (value) => pdf.getObject(value));
    if (!(file instanceof PdfStream)) {
      return panic("Attachment has no embedded file stream");
    }
    file.set("Subtype", PdfName.of(attachment.mimeType));
    associated.push(ref);
  }
  if (associated.length > 0) {
    catalog.set("AF", PdfArray.of(...associated));
  }

  const saved = await savePdfRewrite({
    pdf,
    source,
    // The XMP packet must stay readable without a decoder.
    options: { compressStreams: false },
  });
  if (saved.status !== "saved") {
    return panic("A freshly rendered invoice cannot be signed or encrypted");
  }
  return saved.bytes;
};
