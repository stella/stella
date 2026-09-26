import {
  PDF,
  PdfArray,
  PdfDict,
  PdfNumber,
  PdfRef,
  PdfStream,
} from "@libpdf/core";
import type { PdfObject } from "@libpdf/core";
import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import {
  applySignature,
  captureSigningDigest,
  signaturePlaceholderSize,
} from "@/api/lib/pdf-signing/sign-pdf";
import {
  formatStampTime,
  placeStamp,
  STAMP_SIZE_LIMITS,
} from "@/api/lib/pdf-signing/stamp";
import type {
  SignatureStamp,
  StampRotation,
} from "@/api/lib/pdf-signing/stamp";
import { readSignatureIntegrity } from "@/api/tests/helpers/signed-pdf";
import { createTestCertificate } from "@/api/tests/helpers/test-pki";

const SIGNING_TIME = new Date("2026-06-01T12:00:00.000Z");
/** DigestInfo header for SHA-256, RFC 8017 9.2 step 2. */
const SHA256_DIGEST_INFO_PREFIX = Buffer.from(
  "3031300d060960864801650304020105000420",
  "hex",
);

/** One page 600x800 whose CropBox sits at (10, 20), turned by `rotation`. */
const buildPage = async (rotation: StampRotation) => {
  const created = PDF.create();
  const page = created.addPage({ width: 620, height: 840 });
  page.dict.set(
    "CropBox",
    new PdfArray([10, 20, 610, 820].map((v) => PdfNumber.of(v))),
  );
  if (rotation !== 0) {
    page.dict.set("Rotate", PdfNumber.of(rotation));
  }
  return await created.save();
};

describe("placing a stamp drawn on the displayed page", () => {
  const box = { x: 0, y: 0, width: 0.15, height: 0.1 };

  test.each([
    // Displayed top-left lands on a different CropBox corner per rotation.
    [0, [10, 740, 100, 820]],
    [90, [10, 20, 70, 140]],
    [180, [520, 20, 610, 100]],
    [270, [550, 700, 610, 820]],
  ] as const)("maps a box on a page turned by %d", async (rotation, rect) => {
    const pdf = await PDF.load(await buildPage(rotation));
    const placed = placeStamp({ box, pageIndex: 0, pdf });

    expect(placed).toEqual({
      status: "placed",
      pageIndex: 0,
      rect: [...rect],
      rotation,
    });
  });

  test("honours the CropBox offset, not just the MediaBox", async () => {
    const pdf = await PDF.load(await buildPage(0));
    const placed = placeStamp({
      box: { x: 0.5, y: 0.5, width: 0.2, height: 0.1 },
      pageIndex: 0,
      pdf,
    });

    expect(placed).toEqual({
      status: "placed",
      pageIndex: 0,
      rect: [310, 340, 430, 420],
      rotation: 0,
    });
  });

  test("refuses a box off the page, too small, too large or on a missing page", async () => {
    const pdf = await PDF.load(await buildPage(0));
    const reason = (candidate: Parameters<typeof placeStamp>[0]) => {
      const placed = placeStamp(candidate);
      return placed.status === "rejected" ? placed.reason : null;
    };

    expect(
      reason({
        box: { x: 0.9, y: 0, width: 0.2, height: 0.1 },
        pageIndex: 0,
        pdf,
      }),
    ).toBe("off_page");
    expect(
      reason({
        box: { x: 0, y: 0, width: Number.NaN, height: 0.1 },
        pageIndex: 0,
        pdf,
      }),
    ).toBe("off_page");
    expect(
      reason({
        box: {
          x: 0,
          y: 0,
          width: (STAMP_SIZE_LIMITS.minWidth - 1) / 600,
          height: 0.1,
        },
        pageIndex: 0,
        pdf,
      }),
    ).toBe("too_small");
    expect(
      reason({
        box: { x: 0, y: 0, width: 0.9, height: 0.1 },
        pageIndex: 0,
        pdf,
      }),
    ).toBe("too_large");
    expect(reason({ box, pageIndex: 3, pdf })).toBe("page_not_found");
    expect(reason({ box, pageIndex: -1, pdf })).toBe("page_not_found");
  });
});

describe("the stamp's signing time", () => {
  test("is the recorded instant, in the signer's zone, with its offset", () => {
    expect(formatStampTime(SIGNING_TIME, "Europe/Prague")).toBe(
      "2026-06-01 14:00:00 +02:00",
    );
    expect(formatStampTime(SIGNING_TIME, "Asia/Kolkata")).toBe(
      "2026-06-01 17:30:00 +05:30",
    );
  });
});

const stampOn = (
  rotation: StampRotation,
  rect: SignatureStamp["rect"],
): SignatureStamp => ({
  direction: "ltr",
  labels: {
    date: "Datum",
    location: "Místo",
    reason: "Důvod",
    signedBy: "Digitálně podepsal",
  },
  pageIndex: 0,
  rect,
  rotation,
  timeZone: "Europe/Prague",
});

const signWithStamp = async (rotation: StampRotation) => {
  const basePdf = await buildPage(rotation);
  const placed = placeStamp({
    box: { x: 0.5, y: 0.8, width: 0.4, height: 0.1 },
    pageIndex: 0,
    pdf: await PDF.load(basePdf),
  });
  if (placed.status !== "placed") {
    throw new Error("fixture stamp did not place");
  }
  const signer = await createTestCertificate({ commonName: "Jiří Čermák" });
  const invocation = {
    basePdf,
    certificate: signer.der,
    certificateChain: [],
    keyType: "RSA" as const,
    location: "Brno",
    placeholderSize: signaturePlaceholderSize({
      certificate: signer.der,
      certificateChain: [],
      timestamped: false,
    }),
    reason: null,
    reserveTimestamp: false,
    signatureAlgorithm: "RSASSA-PKCS1-v1_5" as const,
    signingTime: SIGNING_TIME,
    stamp: stampOn(rotation, placed.rect),
  };
  const first = await captureSigningDigest(invocation);
  const second = await captureSigningDigest(invocation);
  const key = crypto.createPrivateKey({
    key: Buffer.from(await crypto.subtle.exportKey("pkcs8", signer.privateKey)),
    format: "der",
    type: "pkcs8",
  });
  const signature = crypto.privateEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.concat([
      SHA256_DIGEST_INFO_PREFIX,
      Buffer.from(first.digestHex, "hex"),
    ]),
  );
  // Phase 2 rebuilds the stamp from the same inputs; the signer below only
  // returns the signature when LibPDF asks for exactly phase 1's digest.
  const applied = await applySignature({
    ...invocation,
    certificateChainComplete: true,
    expectedDigestHex: first.digestHex,
    signature: new Uint8Array(signature),
    timestampAuthorities: [],
    timestampTrustAnchors: [],
  });
  return { applied, first, placed, second };
};

/** Glyph ids in `<hex> Tj` operands, mapped through a ToUnicode CMap. */
const decodeShownText = (content: string, cmap: string) => {
  const unicode = new Map<number, string>();
  const utf16 = (hex: string) =>
    String.fromCodePoint(
      ...(hex.match(/.{4}/gu) ?? []).map((unit) => Number.parseInt(unit, 16)),
    );
  const sections = (name: string) =>
    [...cmap.matchAll(new RegExp(`begin${name}([\\s\\S]*?)end${name}`, "gu"))]
      .map(([, body]) => body ?? "")
      .join("\n");
  for (const [, gid, value] of sections("bfchar").matchAll(
    /<([\da-f]+)>\s*<([\da-f]+)>/giu,
  )) {
    unicode.set(Number.parseInt(gid ?? "", 16), utf16(value ?? ""));
  }
  for (const [, from, to, value] of sections("bfrange").matchAll(
    /<([\da-f]+)>\s*<([\da-f]+)>\s*<([\da-f]+)>/giu,
  )) {
    const first = Number.parseInt(from ?? "", 16);
    const base = Number.parseInt(value ?? "", 16);
    for (let gid = first; gid <= Number.parseInt(to ?? "", 16); gid += 1) {
      unicode.set(gid, String.fromCodePoint(base + gid - first));
    }
  }
  return [...content.matchAll(/<([\da-f]+)>\s*Tj/giu)]
    .map(([, hex]) =>
      (hex?.match(/.{4}/gu) ?? [])
        .map((gid) => unicode.get(Number.parseInt(gid, 16)) ?? "�")
        .join(""),
    )
    .join("\n");
};

/** The stamp widget on page 1 of `bytes`, and its appearance stream. */
const readStamp = async (bytes: Uint8Array) => {
  const pdf = await PDF.load(bytes);
  const resolve = (ref: PdfRef): PdfObject | null => pdf.getObject(ref);
  const page = pdf.getPages().at(0);
  const annotations = page?.dict.getArray("Annots", resolve)?.toArray() ?? [];
  const widget = annotations
    .map((entry) => (entry instanceof PdfRef ? pdf.getObject(entry) : entry))
    .find(
      (entry): entry is PdfDict =>
        entry instanceof PdfDict &&
        entry.getName("FT", resolve)?.value === "Sig",
    );
  const appearanceRef = widget?.getDict("AP", resolve)?.get("N");
  const appearance =
    appearanceRef instanceof PdfRef ? pdf.getObject(appearanceRef) : undefined;
  return { appearance, appearanceRef, page, pdf, widget };
};

describe("signing with a visible stamp", () => {
  test("both phases prepare byte-identical input", async () => {
    const { first, second } = await signWithStamp(0);

    expect(second.digestHex).toBe(first.digestHex);
  });

  test.each([0, 90, 270] as const)(
    "lands the stamp where it was placed on a page turned by %d",
    async (rotation) => {
      const { applied, placed } = await signWithStamp(rotation);
      const { appearance, widget } = await readStamp(applied.bytes);

      const rect = widget
        ?.getArray("Rect")
        ?.toArray()
        .map((entry) =>
          entry instanceof PdfNumber ? entry.value : Number.NaN,
        );
      expect(rect).toEqual([...placed.rect]);
      expect(appearance).toBeInstanceOf(PdfStream);
    },
  );

  test("the signature still covers every byte it signed", async () => {
    const { applied } = await signWithStamp(90);

    const integrity = await readSignatureIntegrity(applied.bytes);
    expect(integrity.length).toBe(1);
    expect(integrity.every(({ digestMatches }) => digestMatches)).toBe(true);
  });

  test("the stamp's text is the signer's name in an embedded Unicode font", async () => {
    const { applied } = await signWithStamp(0);
    const { appearance, appearanceRef, page, pdf } = await readStamp(
      applied.bytes,
    );
    if (
      !(appearance instanceof PdfStream) ||
      !(appearanceRef instanceof PdfRef) ||
      !page
    ) {
      throw new Error("no stamp appearance");
    }
    const resolve = (ref: PdfRef): PdfObject | null => pdf.getObject(ref);
    const font = appearance
      .getDict("Resources", resolve)
      ?.getDict("Font", resolve)
      ?.getDict("F1", resolve);
    // Never a Standard-14 font: a Type0 font with its own glyphs.
    expect(font?.getName("Subtype", resolve)?.value).toBe("Type0");
    const descriptor = font
      ?.getArray("DescendantFonts", resolve)
      ?.at(0, resolve);
    expect(
      descriptor instanceof PdfDict &&
        descriptor.getDict("FontDescriptor", resolve)?.has("FontFile2"),
    ).toBe(true);

    // Read the drawn text back the way a text extractor does: the glyph ids
    // the appearance shows, through the font's ToUnicode map.
    const toUnicode = font?.get("ToUnicode");
    const cmapStream =
      toUnicode instanceof PdfRef ? pdf.getObject(toUnicode) : undefined;
    if (!(cmapStream instanceof PdfStream)) {
      throw new Error("the stamp's font has no ToUnicode map");
    }
    const text = decodeShownText(
      new TextDecoder().decode(appearance.getDecodedData()),
      new TextDecoder().decode(cmapStream.getDecodedData()),
    );

    expect(text).toContain("Jiří Čermák");
    expect(text).toContain("2026-06-01 14:00:00 +02:00");
    expect(text).toContain("Brno");
  });
});
