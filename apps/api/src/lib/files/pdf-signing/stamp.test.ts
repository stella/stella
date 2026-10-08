import {
  PDF,
  PdfArray,
  PdfDict,
  PdfNumber,
  PdfRef,
  PdfStream,
} from "@libpdf/core";
import type { PdfObject } from "@libpdf/core";
import { beforeEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  applySignature,
  captureSigningDigest,
  signaturePlaceholderSize,
} from "@/api/lib/files/pdf-signing/sign-pdf";
import {
  formatStampTime,
  PdfSigningStampError,
  placeStamp,
  STAMP_SIZE_LIMITS,
} from "@/api/lib/files/pdf-signing/stamp";
import type {
  SignatureStamp,
  StampRotation,
} from "@/api/lib/files/pdf-signing/stamp";
import { settled } from "@/api/tests/helpers/settled";
import { readSignatureIntegrity } from "@/api/tests/helpers/signed-pdf";
import {
  createTestRsaKeyPool,
  createTestCertificate,
} from "@/api/tests/helpers/test-pki";

const keyPool = createTestRsaKeyPool();
beforeEach(() => keyPool.reset());

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

  test("accepts a box drawn at exactly the size limits", async () => {
    const pdf = await PDF.load(await buildPage(0));
    // Fractions of a 600x800 page that round-trip to a hair under 72x24.
    const placed = placeStamp({
      box: {
        x: 0.1,
        y: 0.1,
        width: (STAMP_SIZE_LIMITS.minWidth - 1e-9) / 600,
        height: (STAMP_SIZE_LIMITS.minHeight - 1e-9) / 800,
      },
      pageIndex: 0,
      pdf,
    });

    expect(placed.status).toBe("placed");
  });

  test("measures the size limits in physical points on a page with a UserUnit", async () => {
    // Each user unit is 10 points: a 600x800 page is 6000x8000 points, and
    // turned by 90 it displays 800 units wide and 600 high.
    const created = PDF.create();
    const page = created.addPage({ width: 600, height: 800 });
    page.dict.set("UserUnit", PdfNumber.of(10));
    page.dict.set("Rotate", PdfNumber.of(90));
    const pdf = await PDF.load(await created.save());
    const reason = (widthUnits: number, heightUnits: number) => {
      const placed = placeStamp({
        box: {
          x: 0.1,
          y: 0.1,
          width: widthUnits / 800,
          height: heightUnits / 600,
        },
        pageIndex: 0,
        pdf,
      });
      return placed.status === "rejected" ? placed.reason : placed.status;
    };

    // 72x24 units would be 720x240 points: far past the physical maximum.
    expect(reason(72, 24)).toBe("too_large");
    // 7.2x2.4 units is exactly the physical minimum of 72x24 points.
    expect(reason(7.2, 2.4)).toBe("placed");
    expect(reason(7, 2.4)).toBe("too_small");
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

const signWithStamp = async (
  rotation: StampRotation,
  signerName = "Jiří Čermák",
  {
    box = { x: 0.5, y: 0.8, width: 0.4, height: 0.1 },
    location = "Brno",
    reason = null,
  }: {
    box?: { x: number; y: number; width: number; height: number };
    location?: string | null;
    reason?: string | null;
  } = {},
) => {
  const basePdf = await buildPage(rotation);
  const placed = placeStamp({
    box,
    pageIndex: 0,
    pdf: await PDF.load(basePdf),
  });
  if (placed.status !== "placed") {
    throw new Error("fixture stamp did not place");
  }
  const signer = await createTestCertificate({
    keyPool,
    commonName: signerName,
  });
  const invocation = {
    basePdf,
    certificate: signer.der,
    certificateChain: [],
    keyType: "RSA" as const,
    location,
    placeholderSize: signaturePlaceholderSize({
      certificate: signer.der,
      certificateChain: [],
      timestamped: false,
    }),
    reason,
    reserveTimestamp: false,
    signatureAlgorithm: "RSASSA-PKCS1-v1_5" as const,
    signingTime: SIGNING_TIME,
    stamp: stampOn(rotation, placed.rect),
  };
  const first = await settled(captureSigningDigest(invocation));
  const second = await settled(captureSigningDigest(invocation));
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
  const applied = await settled(
    applySignature({
      ...invocation,
      permit: grantThirdPartyOutboundPermit(),
      certificateChainComplete: true,
      expectedDigestHex: first.digestHex,
      signature: new Uint8Array(signature),
      timestampAuthorities: [],
      timestampTrustAnchors: [],
    }),
  );
  return { applied, first, placed, second };
};

/** A ToUnicode CMap's `bfchar` entries: CID to text. */
const parseToUnicode = (cmap: string) => {
  const utf16 = (hex: string) =>
    new TextDecoder("utf-16be").decode(Buffer.from(hex, "hex"));
  const unicode = new Map<number, string>();
  for (const [, body] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
    for (const [, cid, value] of (body ?? "").matchAll(
      /<([\da-f]+)>\s*<([\da-f]*)>/giu,
    )) {
      unicode.set(Number.parseInt(cid ?? "", 16), utf16(value ?? ""));
    }
  }
  return unicode;
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
  if (
    !(appearance instanceof PdfStream) ||
    !(appearanceRef instanceof PdfRef)
  ) {
    throw new Error("no stamp appearance");
  }
  return { appearance, appearanceRef, page, pdf, resolve, widget };
};

/**
 * The appearance's text, row by row, the way an extractor that honours
 * /ActualText reads it: glyphs through their font's ToUnicode map, and a
 * marked span's /ActualText in place of the glyphs inside it. Glyphs come
 * in drawing order, so a left-to-right row reads in logical order.
 */
const readStampRows = async (bytes: Uint8Array) => {
  const { appearance, pdf, resolve } = await readStamp(bytes);
  const fonts = appearance
    .getDict("Resources", resolve)
    ?.getDict("Font", resolve);
  const toUnicode = new Map<string, Map<number, string>>();
  for (const [{ value: name }, ref] of fonts ?? []) {
    const font = ref instanceof PdfRef ? pdf.getObject(ref) : ref;
    const cmapRef = font instanceof PdfDict ? font.get("ToUnicode") : undefined;
    const cmap = cmapRef instanceof PdfRef ? pdf.getObject(cmapRef) : undefined;
    if (!(cmap instanceof PdfStream)) {
      throw new Error(`font ${name} has no ToUnicode map`);
    }
    toUnicode.set(
      name,
      parseToUnicode(new TextDecoder().decode(cmap.getDecodedData())),
    );
  }
  const rows = new Map<string, string>();
  let font = "";
  let row = "";
  let actualText: string | null = null;
  for (const line of new TextDecoder()
    .decode(appearance.getDecodedData())
    .split("\n")) {
    const fontMatch = /^\/(\w+) [\d.]+ Tf$/u.exec(line);
    const matrix = /^1 0 0 1 [\d.-]+ ([\d.-]+) Tm$/u.exec(line);
    const span = /^\/Span << \/ActualText <FEFF([\dA-F]*)> >> BDC$/u.exec(line);
    if (fontMatch) {
      font = fontMatch[1] ?? "";
    } else if (matrix) {
      row = matrix[1] ?? "";
    } else if (span) {
      actualText = new TextDecoder("utf-16be").decode(
        Buffer.from(span[1] ?? "", "hex"),
      );
    } else if (line === "EMC") {
      rows.set(row, (rows.get(row) ?? "") + (actualText ?? ""));
      actualText = null;
    } else if (line.endsWith("TJ") && actualText === null) {
      const unicode = toUnicode.get(font);
      const glyphs = [...line.matchAll(/<([\dA-F]{4})>/gu)].map(
        ([, cid]) => unicode?.get(Number.parseInt(cid ?? "", 16)) ?? "\uFFFD",
      );
      rows.set(row, (rows.get(row) ?? "") + glyphs.join(""));
    }
  }
  return [...rows.values()];
};

/** Invisible characters an extractor may emit between glyphs. */
const withoutInvisibles = (text: string) =>
  text.replaceAll(/\p{Default_Ignorable_Code_Point}/gu, "");

/**
 * The words pdf.js extracts from the stamp, drawn onto its page: the text
 * layer a browser viewer builds. pdf.js reads glyphs through ToUnicode only
 * (it ignores /ActualText), in visual order, and reorders right-to-left
 * text itself.
 */
const pdfJsWords = async (bytes: Uint8Array) => {
  const { appearanceRef, page, pdf } = await readStamp(bytes);
  if (!page) {
    throw new Error("no page");
  }
  page.dict.set(
    "Resources",
    PdfDict.of({ XObject: PdfDict.of({ Stamp: appearanceRef }) }),
  );
  page.dict.set(
    "Contents",
    pdf.context.registry.register(
      new PdfStream(new PdfDict(), new TextEncoder().encode("/Stamp Do")),
    ),
  );
  page.dict.delete("Annots");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({ data: await pdf.save(), verbosity: 0 });
  const content = await (
    await (await loading.promise).getPage(1)
  ).getTextContent();
  const text = content.items
    .map((item) => ("str" in item ? item.str : ""))
    .join(" ");
  await loading.destroy();
  return new Set(
    withoutInvisibles(text)
      .split(/\s+/u)
      // pdf.js moves a colon to the other side of a word in a line it reads
      // as right to left; the word itself is what has to survive.
      .map((word) => word.replaceAll(/\p{P}/gu, ""))
      .filter((word) => word !== ""),
  );
};

describe("signing with a visible stamp", () => {
  test("both phases prepare byte-identical input", async () => {
    const { first, second } = await signWithStamp(0);

    expect(second.digestHex).toBe(first.digestHex);
  });

  test("both phases prepare byte-identical input for shaped scripts", async () => {
    // Phase 2 only returns a signature over phase 1's digest, so signing at
    // all proves the two stamps, fonts and subsets were the same bytes.
    const { applied, first, second } = await signWithStamp(0, "محمد عبد الله", {
      box: { x: 0.1, y: 0.1, width: 400 / 600, height: 120 / 800 },
      location: "東京 서울 กรุงเทพ",
      reason: "अनुबंध דוד כהן",
    });

    expect(second.digestHex).toBe(first.digestHex);
    const integrity = await readSignatureIntegrity(applied.bytes);
    expect(integrity.every(({ digestMatches }) => digestMatches)).toBe(true);
  });

  test.each([0, 90, 270] as const)(
    "lands the stamp where it was placed on a page turned by %d",
    async (rotation) => {
      const { applied, placed } = await signWithStamp(rotation);
      const { widget } = await readStamp(applied.bytes);

      const rect = widget
        ?.getArray("Rect")
        ?.toArray()
        .map((entry) =>
          entry instanceof PdfNumber ? entry.value : Number.NaN,
        );
      expect(rect).toEqual([...placed.rect]);
    },
  );

  test("refuses, before any digest, a name in a script it cannot shape or draw", async () => {
    for (const name of ["முருகன்", "\u{13000}"]) {
      const refused = await signWithStamp(0, name).catch(
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(PdfSigningStampError);
      expect(PdfSigningStampError.is(refused) && refused.reason).toBe(
        "unrenderable",
      );
    }
  });

  test("wraps the longest accepted text inside the largest box", async () => {
    // A 64-character name (the X.520 upper bound) and a reason and location
    // at the handoff's 256-character cap, in a 400 x 200 pt box.
    const name =
      "Maximilián Křižovnický-Dvořáková von Hohenzollern-Sigmaringen Jr";
    const reason = "Schváleno ".repeat(26).slice(0, 256);
    const location = "Nábřeží ".repeat(33).slice(0, 256);
    const { applied } = await signWithStamp(0, name, {
      box: { x: 0.1, y: 0.1, width: 400 / 600, height: 200 / 800 },
      location,
      reason,
    });
    const { appearance } = await readStamp(applied.bytes);
    const text = withoutInvisibles(
      (await readStampRows(applied.bytes)).join(" "),
    );

    // Every word is there, wrapped over rows, none clipped away.
    expect(text.replaceAll(/\s+/gu, " ")).toContain(name);
    expect(text.replaceAll(/\s+/gu, "")).toContain(
      reason.replaceAll(/\s+/gu, ""),
    );
    const content = new TextDecoder().decode(appearance.getDecodedData());
    const fontSize = Number(/\/F1 ([\d.]+) Tf/u.exec(content)?.[1]);
    expect(fontSize).toBeGreaterThanOrEqual(6);
  });

  test("refuses, before any digest, text that will not fit its box readably", async () => {
    const refused = await signWithStamp(0, "Jiří Čermák", {
      box: { x: 0.1, y: 0.1, width: 72 / 600, height: 24 / 800 },
      reason: "Schváleno ".repeat(20),
    }).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(PdfSigningStampError);
    expect(PdfSigningStampError.is(refused) && refused.reason).toBe("overflow");
  });

  test("the signature still covers every byte it signed", async () => {
    const { applied } = await signWithStamp(90);

    const integrity = await readSignatureIntegrity(applied.bytes);
    expect(integrity.length).toBe(1);
    expect(integrity.every(({ digestMatches }) => digestMatches)).toBe(true);
  });

  test("the stamp's text is the signer's name in an embedded Unicode font", async () => {
    const { applied } = await signWithStamp(0);
    const { appearance, resolve } = await readStamp(applied.bytes);
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

    const rows = (await readStampRows(applied.bytes)).map(withoutInvisibles);
    expect(rows).toEqual([
      "Digitálně podepsal Jiří Čermák",
      "Datum: 2026-06-01 14:00:00 +02:00",
      "Místo: Brno",
    ]);
  });

  test("reads back every script exactly where /ActualText is honoured", async () => {
    const { applied } = await signWithStamp(0, "Jiří Čermák", {
      box: { x: 0.1, y: 0.1, width: 400 / 600, height: 120 / 800 },
      location: "नई दिल्ली · กรุงเทพ · 東京 · 서울",
      reason: "Приложение Ελληνικά",
    });

    const rows = (await readStampRows(applied.bytes)).map(withoutInvisibles);
    expect(rows).toEqual([
      "Digitálně podepsal Jiří Čermák",
      "Datum: 2026-06-01 14:00:00 +02:00",
      "Důvod: Приложение Ελληνικά",
      "Místo: नई दिल्ली · กรุงเทพ · 東京 · 서울",
    ]);
  });

  test("a browser's text layer finds every right-to-left word whole", async () => {
    const { applied } = await signWithStamp(0, "محمد عبد الله", {
      box: { x: 0.1, y: 0.1, width: 400 / 600, height: 120 / 800 },
      location: "תל אביב",
      reason: "דוד כהן 2026",
    });

    const words = await pdfJsWords(applied.bytes);
    for (const word of [
      "محمد",
      "عبد",
      "الله",
      "דוד",
      "כהן",
      "2026",
      "תל",
      "אביב",
      "Digitálně",
      "podepsal",
      "Místo",
    ]) {
      expect(words).toContain(word);
    }
  });
});
