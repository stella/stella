import {
  PdfArray,
  PdfDict,
  PdfName,
  PdfNumber,
  PdfStream,
  PdfString,
} from "@libpdf/core";
/**
 * Shaped stamp rows as PDF text: one Type0 font (CIDFontType2, Identity-H)
 * per face used, subset to the glyphs drawn, and the content operators
 * that place each glyph where the shaper put it.
 *
 * Text extraction reads the glyphs back through each font's ToUnicode map,
 * which can only state one text per glyph. Where a cluster is not one glyph
 * standing for its own text (a ligature, a conjunct, a glyph that means
 * different text in different places), the cluster is also wrapped in a
 * marked-content span whose /ActualText is the cluster's text.
 *
 * Both signing phases draw the same stamp and must write the same bytes,
 * so every choice here is a function of the glyphs drawn: fonts are
 * written in face order, subset tags are derived from their glyphs, and
 * nothing iterates in an order that depends on anything else.
 */
import type { PDF, PdfRef } from "@libpdf/core";
import { panic } from "better-result";

import { subsetTrueType } from "@stll/folio-core/text-shaping";
import { sha256Bytes as hashSha256Bytes } from "@stll/sha256/bun";

import type { StampFace } from "@/api/lib/files/pdf-signing/stamp-font";
import {
  STAMP_UNITS_PER_EM,
  type StampGlyph,
  type StampRow,
  type StampRun,
} from "@/api/lib/files/pdf-signing/stamp-layout";

/** Fixed precision keeps the content stream byte-identical across phases. */
export const pdfNumber = (value: number) => {
  const fixed = value.toFixed(3);
  return fixed === "-0.000" ? "0.000" : fixed;
};

const hex4 = (value: number) =>
  value.toString(16).toUpperCase().padStart(4, "0");

/** UTF-16BE hex, as ToUnicode and a text string both spell text. */
const utf16Hex = (text: string) =>
  Buffer.from(text, "utf16le").swap16().toString("hex").toUpperCase();

/** Consecutive glyphs of one cluster; a shaped run keeps clusters together. */
const clusterGroups = (run: StampRun) => {
  const groups: StampGlyph[][] = [];
  for (const glyph of run.glyphs) {
    const last = groups.at(-1);
    if (last?.[0]?.cluster === glyph.cluster) {
      last.push(glyph);
    } else {
      groups.push([glyph]);
    }
  }
  return groups;
};

type FaceUsage = {
  face: StampFace;
  glyphIds: Set<number>;
  /** Glyph id to the text it stands for, as first drawn. */
  toUnicode: Map<number, string>;
  /** Glyphs that stood for different text in different places. */
  ambiguous: Set<number>;
};

/**
 * What a glyph that stands for no character of its cluster maps to (the
 * second glyph of a Devanagari independent vowel drawn in two pieces).
 * Extractors read an empty or missing ToUnicode entry as the glyph's code,
 * so it maps to a zero width space instead, and its cluster always carries
 * /ActualText.
 */
const STANDS_FOR_NOTHING = "\u200B";

/**
 * The text each glyph of one cluster stands for, in drawing order. A glyph
 * that is the face's own glyph for one of the cluster's characters stands
 * for it; the characters left over go to the first glyph that got none (or
 * to the first glyph), and any other glyph stands for nothing.
 */
const glyphTexts = (
  face: StampFace,
  group: readonly StampGlyph[],
  text: string,
): string[] => {
  if (group.length === 1) {
    return [text];
  }
  // A cmap maps code points, so a cluster is matched one code point at a time.
  const remaining = Array.from(text);
  const own = group.map(({ glyphId }) => {
    const index = remaining.findIndex(
      (character) =>
        face.font.glyphIdFor(character.codePointAt(0) ?? 0) === glyphId,
    );
    return index === -1 ? null : (remaining.splice(index, 1)[0] ?? null);
  });
  const carrier = Math.max(own.indexOf(null), 0);
  return own.map((character, index) =>
    index === carrier
      ? `${character ?? ""}${remaining.join("")}` || STANDS_FOR_NOTHING
      : (character ?? STANDS_FOR_NOTHING),
  );
};

const usageOf = (rows: readonly StampRow[]) => {
  const usage = new Map<StampFace, FaceUsage>();
  for (const run of rows.flatMap(({ runs }) => runs)) {
    let entry = usage.get(run.face);
    if (entry === undefined) {
      entry = {
        ambiguous: new Set(),
        face: run.face,
        glyphIds: new Set(),
        toUnicode: new Map(),
      };
      usage.set(run.face, entry);
    }
    for (const group of clusterGroups(run)) {
      const texts = glyphTexts(
        run.face,
        group,
        run.clusterText.get(group[0]?.cluster ?? 0) ?? "",
      );
      for (const [index, { glyphId }] of group.entries()) {
        const text = texts[index] ?? "";
        entry.glyphIds.add(glyphId);
        const known = entry.toUnicode.get(glyphId);
        if (known === undefined) {
          entry.toUnicode.set(glyphId, text);
        } else if (known !== text) {
          entry.ambiguous.add(glyphId);
        }
      }
    }
  }
  return usage;
};

/**
 * Whether the glyphs' ToUnicode entries, read in drawing order, miss the
 * cluster's text: a glyph that means different text elsewhere, or glyphs
 * drawn in another order than their characters (a Devanagari i-matra, an
 * Arabic mark).
 */
const needsActualText = (
  usage: FaceUsage,
  run: StampRun,
  group: readonly StampGlyph[],
) =>
  group.some(({ glyphId }) => usage.ambiguous.has(glyphId)) ||
  group.map(({ glyphId }) => usage.toUnicode.get(glyphId) ?? "").join("") !==
    run.clusterText.get(group[0]?.cluster ?? 0);

/** Six capital letters derived from the subset, so both phases agree. */
const subsetTag = (face: StampFace, glyphIds: readonly number[]) => {
  const hash = hashSha256Bytes(`${face.key}\n${glyphIds.join(",")}`);
  return Array.from(hash.subarray(0, 6), (byte) =>
    String.fromCodePoint(65 + (byte % 26)),
  ).join("");
};

const toUnicodeCMap = (entries: readonly (readonly [number, string])[]) => {
  const lines = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
  ];
  // A bfchar section holds at most 100 entries.
  for (let start = 0; start < entries.length; start += 100) {
    const chunk = entries.slice(start, start + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [cid, text] of chunk) {
      lines.push(`<${hex4(cid)}> <${utf16Hex(text)}>`);
    }
    lines.push("endbfchar");
  }
  lines.push(
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end",
  );
  return new TextEncoder().encode(lines.join("\n"));
};

type EmbeddedFace = {
  ref: PdfRef;
  resource: string;
  /** Glyph id in the face to glyph id (and CID) in the subset. */
  subsetGlyphId: ReadonlyMap<number, number>;
  /** Advance each glyph is declared with, in thousandths of an em. */
  declaredWidth: ReadonlyMap<number, number>;
};

const embedFace = (pdf: PDF, usage: FaceUsage, resource: string) => {
  const { face } = usage;
  const glyphIds = [...usage.glyphIds].toSorted((a, b) => a - b);
  const subset = subsetTrueType(face.font, new Set(glyphIds));
  if (subset.isErr()) {
    return panic(`The stamp font ${face.key} does not subset`, subset.error);
  }
  const { bytes, glyphIdMap } = subset.value;
  const scale = STAMP_UNITS_PER_EM / face.font.unitsPerEm;
  const cidOf = (glyphId: number) =>
    glyphIdMap.get(glyphId) ??
    panic(`The subset of ${face.key} lost glyph ${glyphId}`);
  const declaredWidth = new Map(
    glyphIds.map((glyphId) => [
      glyphId,
      Math.round(face.font.advanceWidthFor(glyphId) * scale),
    ]),
  );
  const widths = glyphIds.flatMap((glyphId) => [
    PdfNumber.of(cidOf(glyphId)),
    new PdfArray([PdfNumber.of(declaredWidth.get(glyphId) ?? 0)]),
  ]);
  const name = `${subsetTag(face, glyphIds)}+${face.font.postScriptName}`;
  const register = (object: PdfDict | PdfStream) =>
    pdf.context.registry.register(object);
  const fontFile = register(
    new PdfStream(PdfDict.of({ Length1: PdfNumber.of(bytes.length) }), bytes),
  );
  const toUnicode = register(
    new PdfStream(
      new PdfDict(),
      toUnicodeCMap(
        glyphIds.map(
          (glyphId) =>
            [cidOf(glyphId), usage.toUnicode.get(glyphId) ?? ""] as const,
        ),
      ),
    ),
  );
  const descriptor = register(
    PdfDict.of({
      Type: PdfName.of("FontDescriptor"),
      FontName: PdfName.of(name),
      // Symbolic: glyphs are addressed by id, not by a standard encoding.
      Flags: PdfNumber.of(4),
      FontBBox: new PdfArray(
        face.font.bbox.map((value) => PdfNumber.of(Math.round(value * scale))),
      ),
      ItalicAngle: PdfNumber.of(face.font.italicAngle),
      Ascent: PdfNumber.of(Math.round(face.font.ascender * scale)),
      Descent: PdfNumber.of(Math.round(face.font.descender * scale)),
      CapHeight: PdfNumber.of(Math.round(face.font.capHeight * scale)),
      StemV: PdfNumber.of(80),
      FontFile2: fontFile,
    }),
  );
  const cidFont = register(
    PdfDict.of({
      Type: PdfName.of("Font"),
      Subtype: PdfName.of("CIDFontType2"),
      BaseFont: PdfName.of(name),
      CIDSystemInfo: PdfDict.of({
        Registry: PdfString.fromString("Adobe"),
        Ordering: PdfString.fromString("Identity"),
        Supplement: PdfNumber.of(0),
      }),
      FontDescriptor: descriptor,
      W: new PdfArray(widths),
      CIDToGIDMap: PdfName.of("Identity"),
    }),
  );
  const ref = register(
    PdfDict.of({
      Type: PdfName.of("Font"),
      Subtype: PdfName.of("Type0"),
      BaseFont: PdfName.of(name),
      Encoding: PdfName.of("Identity-H"),
      DescendantFonts: new PdfArray([cidFont]),
      ToUnicode: toUnicode,
    }),
  );
  return {
    declaredWidth,
    ref,
    resource,
    subsetGlyphId: new Map(
      glyphIds.map((glyphId) => [glyphId, cidOf(glyphId)]),
    ),
  } satisfies EmbeddedFace;
};

/** Operators that draw one run from the current pen position. */
const runOperators = ({
  embedded,
  fontSize,
  run,
  usage,
}: {
  embedded: EmbeddedFace;
  fontSize: number;
  run: StampRun;
  usage: FaceUsage;
}) => {
  const operators: string[] = [];
  let shown: string[] = [];
  let rise = 0;
  const flush = () => {
    if (shown.length > 0) {
      operators.push(`[${shown.join(" ")}] TJ`);
    }
    shown = [];
  };
  for (const group of clusterGroups(run)) {
    const actualText = needsActualText(usage, run, group);
    if (actualText) {
      flush();
      operators.push(
        `/Span << /ActualText <FEFF${utf16Hex(run.clusterText.get(group[0]?.cluster ?? 0) ?? "")}> >> BDC`,
      );
    }
    for (const glyph of group) {
      if (glyph.yOffset !== rise) {
        flush();
        rise = glyph.yOffset;
        operators.push(
          `${pdfNumber((rise * fontSize) / STAMP_UNITS_PER_EM)} Ts`,
        );
      }
      // A TJ number moves the pen left by thousandths of the font size:
      // shift by the glyph's offset, draw it, then take back the offset and
      // whatever its declared width differs from the shaped advance.
      if (glyph.xOffset !== 0) {
        shown.push(pdfNumber(-glyph.xOffset));
      }
      const cid =
        embedded.subsetGlyphId.get(glyph.glyphId) ??
        panic(`Glyph ${glyph.glyphId} was not embedded`);
      shown.push(`<${hex4(cid)}>`);
      const adjust =
        (embedded.declaredWidth.get(glyph.glyphId) ?? 0) -
        glyph.xAdvance +
        glyph.xOffset;
      if (Math.abs(adjust) >= 0.0005) {
        shown.push(pdfNumber(adjust));
      }
    }
    if (actualText) {
      flush();
      operators.push("EMC");
    }
  }
  flush();
  if (rise !== 0) {
    operators.push("0 Ts");
  }
  return operators;
};

type StampTextRow = {
  row: StampRow;
  /** Left end of the row's baseline, in appearance space. */
  x: number;
  y: number;
};

/**
 * Embed the fonts the rows use and return the operators that draw them
 * (inside BT/ET) and the font resources they name.
 */
export const drawStampRows = ({
  fontSize,
  pdf,
  rows,
}: {
  fontSize: number;
  pdf: PDF;
  rows: readonly StampTextRow[];
}): { fonts: PdfDict; operators: string[] } => {
  const usage = usageOf(rows.map(({ row }) => row));
  // Face order, not first use: the same stamp names its fonts the same way.
  const faces = [...usage.keys()].toSorted((a, b) => {
    if (a.key === b.key) {
      return 0;
    }
    return a.key < b.key ? -1 : 1;
  });
  const embedded = new Map(
    faces.map((face, index) => [
      face,
      embedFace(
        pdf,
        usage.get(face) ?? panic("face usage vanished"),
        `F${index + 1}`,
      ),
    ]),
  );
  const operators: string[] = [];
  for (const { row, x, y } of rows) {
    let pen = x;
    for (const run of row.runs) {
      const face =
        embedded.get(run.face) ?? panic(`${run.face.key} was not embedded`);
      operators.push(
        `/${face.resource} ${pdfNumber(fontSize)} Tf`,
        `1 0 0 1 ${pdfNumber(pen)} ${pdfNumber(y)} Tm`,
        ...runOperators({
          embedded: face,
          fontSize,
          run,
          usage: usage.get(run.face) ?? panic("face usage vanished"),
        }),
      );
      pen +=
        (run.glyphs.reduce((sum, { xAdvance }) => sum + xAdvance, 0) *
          fontSize) /
        STAMP_UNITS_PER_EM;
    }
  }
  const fonts = new PdfDict();
  for (const face of embedded.values()) {
    fonts.set(face.resource, face.ref);
  }
  return { fonts, operators };
};
