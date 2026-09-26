/**
 * The visible part of a signature: a stamp on one page that names the
 * signer and the signing time.
 *
 * Placement arrives from the browser in fractions of the page as displayed
 * (after /Rotate, inside the CropBox) and is converted here to a rectangle
 * in PDF user space, so what the user drew is where the stamp lands on any
 * page geometry.
 *
 * The stamp is part of what gets signed: its field, widget, appearance and
 * font are written in the same revision as the signature. Both signing
 * phases therefore build it from the same persisted inputs (placement,
 * labels, time zone, the certificate's name, the signing time) and must
 * produce identical bytes, which is why nothing here reads the clock or
 * draws randomness.
 */

import {
  PdfArray,
  PdfDict,
  PdfName,
  PdfNumber,
  PdfRef,
  PdfStream,
} from "@libpdf/core";
import type { PDF, PdfObject } from "@libpdf/core";
import { TaggedError } from "better-result";
import * as pkijs from "pkijs";

import { Temporal } from "@stll/time";

import type { PdfSigningStamp, PdfSigningStampRotation } from "@/api/db/schema";

/** The stamp cannot be put on the document it was placed for. */
export class PdfSigningStampError extends TaggedError("PdfSigningStampError")<{
  message: string;
}> {}

/** Names the stamp's signature field gets, numbered past existing ones. */
const STAMP_FIELD_PREFIX = "StellaSignature";

/** Stamp size bounds in points: legible, and never a page-covering box. */
export const STAMP_SIZE_LIMITS = {
  maxHeight: 200,
  maxWidth: 400,
  minHeight: 24,
  minWidth: 72,
} as const;

/** Fractions may be off by rounding in the browser. */
const FRACTION_TOLERANCE = 1e-6;
/** The same rounding, in points. */
const SIZE_TOLERANCE = 1e-3;

const MAX_FONT_SIZE = 10;
const MIN_FONT_SIZE = 3;
const LINE_HEIGHT = 1.25;
/** /F Print: the stamp prints with the page. */
const ANNOTATION_FLAG_PRINT = 4;
const COMMON_NAME_OID = "2.5.4.3";

export type StampRotation = PdfSigningStampRotation;

/** What a session stores for a visible stamp. */
export type SignatureStamp = PdfSigningStamp;

/** A box in fractions of the displayed page, top-left origin. */
export type ViewerBox = {
  height: number;
  width: number;
  x: number;
  y: number;
};

export type StampPlacementRejection =
  | "page_not_found"
  | "off_page"
  | "too_small"
  | "too_large";

export type StampPlacement =
  | {
      status: "placed";
      pageIndex: number;
      rect: SignatureStamp["rect"];
      rotation: StampRotation;
    }
  | { status: "rejected"; reason: StampPlacementRejection };

type PageBox = { height: number; width: number; x: number; y: number };

/** US Letter, the default ISO 32000 gives a page without a MediaBox. */
const DEFAULT_MEDIA_BOX: PageBox = { x: 0, y: 0, width: 612, height: 792 };

/**
 * An inheritable page attribute (ISO 32000-1 7.7.3.4): the page's own, or
 * the nearest one up its /Parent chain.
 */
const inherited = (pdf: PDF, page: PdfDict, key: string) => {
  const resolve = (ref: PdfRef): PdfObject | null => pdf.getObject(ref);
  const seen = new Set<PdfDict>();
  let node: PdfDict | undefined = page;
  while (node !== undefined && !seen.has(node)) {
    seen.add(node);
    const value = node.get(key, resolve);
    if (value !== undefined) {
      return value;
    }
    node = node.getDict("Parent", resolve);
  }
  return undefined;
};

/** A box array as a normalized rectangle (corners may come in any order). */
const asBox = (value: PdfObject | undefined): PageBox | null => {
  if (!(value instanceof PdfArray) || value.length < 4) {
    return null;
  }
  const corners = value
    .toArray()
    .slice(0, 4)
    .map((entry) => (entry instanceof PdfNumber ? entry.value : Number.NaN));
  const [ax = Number.NaN, ay = Number.NaN, bx = Number.NaN, by = Number.NaN] =
    corners;
  if (![ax, ay, bx, by].every(Number.isFinite)) {
    return null;
  }
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
};

/**
 * The page as displayed: its CropBox (clipped to the MediaBox, both
 * possibly inherited) and its /Rotate. Read here rather than through
 * LibPDF 0.4.2's page helpers, which neither inherit these nor return a
 * box's size for a box that does not start at the origin.
 */
const displayedPage = (pdf: PDF, page: PdfDict) => {
  const media = asBox(inherited(pdf, page, "MediaBox")) ?? DEFAULT_MEDIA_BOX;
  const crop = asBox(inherited(pdf, page, "CropBox")) ?? media;
  const x = Math.max(crop.x, media.x);
  const y = Math.max(crop.y, media.y);
  const box: PageBox = {
    x,
    y,
    width: Math.max(
      0,
      Math.min(crop.x + crop.width, media.x + media.width) - x,
    ),
    height: Math.max(
      0,
      Math.min(crop.y + crop.height, media.y + media.height) - y,
    ),
  };
  const rotate = inherited(pdf, page, "Rotate");
  const degrees = rotate instanceof PdfNumber ? rotate.value : 0;
  const normalized = (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
  const rotation: StampRotation =
    normalized === 90 || normalized === 180 || normalized === 270
      ? normalized
      : 0;
  return { box, rotation };
};

const isFraction = (value: number) =>
  Number.isFinite(value) &&
  value >= -FRACTION_TOLERANCE &&
  value <= 1 + FRACTION_TOLERANCE;

/**
 * Where a box drawn on the displayed page lies in user space.
 *
 * `(u, v)` are displayed coordinates (right, down) from the displayed
 * top-left; each /Rotate maps them onto the CropBox differently.
 */
const toUserSpace = (
  crop: { height: number; width: number; x: number; y: number },
  rotation: StampRotation,
  u: number,
  v: number,
): [number, number] => {
  const left = crop.x;
  const bottom = crop.y;
  const right = crop.x + crop.width;
  const top = crop.y + crop.height;
  switch (rotation) {
    case 0: {
      return [left + u, top - v];
    }
    case 90: {
      return [left + v, bottom + u];
    }
    case 180: {
      return [right - u, bottom + v];
    }
    case 270: {
      return [right - v, top - u];
    }
  }
};

export const placeStamp = ({
  box,
  pageIndex,
  pdf,
}: {
  box: ViewerBox;
  pageIndex: number;
  pdf: PDF;
}): StampPlacement => {
  const page = Number.isInteger(pageIndex)
    ? pdf.getPages().at(pageIndex)
    : undefined;
  if (page === undefined || pageIndex < 0) {
    return { status: "rejected", reason: "page_not_found" };
  }
  if (
    ![box.x, box.y, box.width, box.height].every(isFraction) ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x + box.width > 1 + FRACTION_TOLERANCE ||
    box.y + box.height > 1 + FRACTION_TOLERANCE
  ) {
    return { status: "rejected", reason: "off_page" };
  }

  const { box: crop, rotation } = displayedPage(pdf, page.dict);
  const turned = rotation === 90 || rotation === 270;
  const displayedWidth = turned ? crop.height : crop.width;
  const displayedHeight = turned ? crop.width : crop.height;
  const width = box.width * displayedWidth;
  const height = box.height * displayedHeight;
  // A box drawn at exactly a limit comes back a hair off it after the
  // browser's fraction round trip.
  if (
    width < STAMP_SIZE_LIMITS.minWidth - SIZE_TOLERANCE ||
    height < STAMP_SIZE_LIMITS.minHeight - SIZE_TOLERANCE
  ) {
    return { status: "rejected", reason: "too_small" };
  }
  if (
    width > STAMP_SIZE_LIMITS.maxWidth + SIZE_TOLERANCE ||
    height > STAMP_SIZE_LIMITS.maxHeight + SIZE_TOLERANCE
  ) {
    return { status: "rejected", reason: "too_large" };
  }

  const u = box.x * displayedWidth;
  const v = box.y * displayedHeight;
  const [x1, y1] = toUserSpace(crop, rotation, u, v);
  const [x2, y2] = toUserSpace(crop, rotation, u + width, v + height);
  return {
    status: "placed",
    pageIndex,
    rect: [
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
    ],
    rotation,
  };
};

/** The certificate's subject common name, the name the stamp shows. */
export const certificateSubjectName = (certificate: Uint8Array): string => {
  try {
    const parsed = pkijs.Certificate.fromBER(new Uint8Array(certificate));
    const value = parsed.subject.typesAndValues.find(
      ({ type }) => type === COMMON_NAME_OID,
    )?.value.valueBlock.value;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
};

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/**
 * The signing time as the stamp shows it: numeric, in the signer's time
 * zone, with the offset, so it reads the same in every language and states
 * exactly the instant the signature records.
 */
export const formatStampTime = (signingTime: Date, timeZone: string) => {
  const zoned = Temporal.Instant.fromEpochMilliseconds(
    signingTime.getTime(),
  ).toZonedDateTimeISO(timeZone);
  return `${pad(zoned.year, 4)}-${pad(zoned.month)}-${pad(zoned.day)} ${pad(zoned.hour)}:${pad(zoned.minute)}:${pad(zoned.second)} ${zoned.offset}`;
};

export const stampLines = ({
  location,
  reason,
  signerName,
  signingTime,
  stamp,
}: {
  location: string | null;
  reason: string | null;
  signerName: string;
  signingTime: Date;
  stamp: SignatureStamp;
}): string[] => [
  `${stamp.labels.signedBy} ${signerName}`.trim(),
  `${stamp.labels.date}: ${formatStampTime(signingTime, stamp.timeZone)}`,
  ...(reason === null ? [] : [`${stamp.labels.reason}: ${reason}`]),
  ...(location === null ? [] : [`${stamp.labels.location}: ${location}`]),
];

/** Fixed precision keeps the content stream byte-identical across phases. */
const num = (value: number) => {
  const fixed = value.toFixed(3);
  return fixed === "-0.000" ? "0.000" : fixed;
};

/**
 * Six capital letters derived from what the subset holds. LibPDF picks a
 * random subset tag; a derived one keeps both phases' bytes identical.
 */
const subsetTag = (lines: readonly string[]) => {
  const hash = new Bun.CryptoHasher("sha256").update(lines.join("\n")).digest();
  return Array.from(hash.subarray(0, 6), (byte) =>
    String.fromCodePoint(65 + (byte % 26)),
  ).join("");
};

const retagSubsetFont = (pdf: PDF, fontRef: PdfRef, tag: string) => {
  const resolve = (ref: PdfRef): PdfObject | null => pdf.getObject(ref);
  const retag = (dict: PdfDict | undefined, key: string) => {
    const name = dict?.getName(key, resolve)?.value;
    if (dict !== undefined && name !== undefined && name.includes("+")) {
      dict.set(key, PdfName.of(`${tag}${name.slice(name.indexOf("+"))}`));
    }
  };
  const type0 = pdf.getObject(fontRef);
  if (!(type0 instanceof PdfDict)) {
    return;
  }
  retag(type0, "BaseFont");
  const descendant = type0.getArray("DescendantFonts", resolve)?.at(0, resolve);
  if (descendant instanceof PdfDict) {
    retag(descendant, "BaseFont");
    retag(descendant.getDict("FontDescriptor", resolve), "FontName");
  }
};

const nextFieldName = (pdf: PDF) => {
  const taken = new Set(pdf.getForm()?.getFieldNames());
  let index = 1;
  while (taken.has(`${STAMP_FIELD_PREFIX}${index}`)) {
    index += 1;
  }
  return `${STAMP_FIELD_PREFIX}${index}`;
};

/** Counter-rotates the appearance so the stamp reads upright on screen. */
const APPEARANCE_MATRIX = {
  0: [1, 0, 0, 1],
  90: [0, 1, -1, 0],
  180: [-1, 0, 0, -1],
  270: [0, -1, 1, 0],
} as const satisfies Record<StampRotation, readonly number[]>;

/**
 * Add the stamp's signature field, widget and appearance to `pdf`, and
 * return the field name to sign into. Must run before `pdf.sign`, in both
 * phases, with the same inputs.
 */
export const addSignatureStamp = ({
  fontBytes,
  lines,
  pdf,
  stamp,
}: {
  /** See `stamp-font.ts`. */
  fontBytes: Uint8Array;
  lines: readonly string[];
  pdf: PDF;
  stamp: SignatureStamp;
}): string => {
  const page = pdf.getPages().at(stamp.pageIndex);
  if (page === undefined) {
    throw new PdfSigningStampError({
      message: "The stamp's page is not in this document.",
    });
  }
  const [x1, y1, x2, y2] = stamp.rect;
  const turned = stamp.rotation === 90 || stamp.rotation === 270;
  const width = turned ? y2 - y1 : x2 - x1;
  const height = turned ? x2 - x1 : y2 - y1;

  const font = pdf.embedFont(fontBytes);
  const padding = Math.min(6, height * 0.1, width * 0.05);
  const unitWidth = (text: string) =>
    [...text].reduce(
      (total, character) =>
        total + font.getWidth(character.codePointAt(0) ?? 0) / 1000,
      0,
    );
  const fontSize = Math.max(
    MIN_FONT_SIZE,
    Math.min(
      MAX_FONT_SIZE,
      (height - 2 * padding) / (lines.length * LINE_HEIGHT),
      ...lines.map(
        (line) => (width - 2 * padding) / Math.max(unitWidth(line), 0.01),
      ),
    ),
  );

  const operators = [
    "q",
    "0.35 0.35 0.35 RG",
    "0.6 w",
    `0.300 0.300 ${num(width - 0.6)} ${num(height - 0.6)} re`,
    "S",
    "Q",
    "BT",
    "0.1 0.1 0.1 rg",
    `/F1 ${num(fontSize)} Tf`,
  ];
  for (const [index, line] of lines.entries()) {
    const lineWidth = unitWidth(line) * fontSize;
    const x = stamp.direction === "rtl" ? width - padding - lineWidth : padding;
    const y = height - padding - fontSize - index * fontSize * LINE_HEIGHT;
    const glyphs = font
      .encodeTextToGids(line)
      .map((gid) => gid.toString(16).padStart(4, "0"))
      .join("");
    operators.push(`1 0 0 1 ${num(x)} ${num(y)} Tm`, `<${glyphs}> Tj`);
  }
  operators.push("ET");

  // Subset now, with a derived tag, rather than at save with a random one.
  pdf.fonts.finalize(true);
  retagSubsetFont(pdf, font.ref, subsetTag(lines));

  const appearance = pdf.context.registry.register(
    new PdfStream(
      PdfDict.of({
        Type: PdfName.of("XObject"),
        Subtype: PdfName.of("Form"),
        BBox: new PdfArray([0, 0, width, height].map((v) => PdfNumber.of(v))),
        Matrix: new PdfArray(
          [...APPEARANCE_MATRIX[stamp.rotation], 0, 0].map((v) =>
            PdfNumber.of(v),
          ),
        ),
        Resources: PdfDict.of({ Font: PdfDict.of({ F1: font.ref }) }),
      }),
      new TextEncoder().encode(operators.join("\n")),
    ),
  );

  const fieldName = nextFieldName(pdf);
  const form = pdf.getOrCreateForm();
  const widget = form.createSignatureField(fieldName).getDict();
  const acroFormFields = pdf
    .getCatalog()
    .getDict("AcroForm", (ref) => pdf.getObject(ref))
    ?.getArray("Fields");
  const widgetRef = acroFormFields?.at(-1);
  if (!(widgetRef instanceof PdfRef) || pdf.getObject(widgetRef) !== widget) {
    throw new PdfSigningStampError({
      message: "The stamp's field could not be located.",
    });
  }

  widget.set("Rect", new PdfArray(stamp.rect.map((v) => PdfNumber.of(v))));
  widget.set("P", page.ref);
  widget.set("F", PdfNumber.of(ANNOTATION_FLAG_PRINT));
  widget.set("AP", PdfDict.of({ N: appearance }));
  // LibPDF 0.4.2 always turns the field it signs into a zero-size widget on
  // the first page; it has no visible-signature option. Keep the placement
  // this stamp gave the widget.
  const pinned = new Set(["Rect", "P"]);
  const set = widget.set.bind(widget);
  widget.set = (key, value) => {
    const name = typeof key === "string" ? key : key.value;
    if (!pinned.has(name)) {
      set(key, value);
    }
  };

  const annotations = page.dict.getArray("Annots", (ref) => pdf.getObject(ref));
  if (annotations === undefined) {
    page.dict.set("Annots", new PdfArray([widgetRef]));
  } else {
    annotations.push(widgetRef);
  }
  return fieldName;
};
