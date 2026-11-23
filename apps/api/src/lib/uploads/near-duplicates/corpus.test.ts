/**
 * Precision and recall of near-duplicate detection on a corpus of public
 * license texts: legal documents of one type that anyone may copy.
 *
 * Duplicates are an identical copy, the DOCX and PDF renderings of one text
 * read back through the extraction worker, small edits, one changed clause,
 * and one license under different copyright holders. Every other pair of
 * license families must not match. The report lines carry the measured
 * numbers that the thresholds in `minhash.ts` were tuned on.
 */

import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { ZipArchive } from "@stll/docx-core/zip";

import { extractFileTextResult } from "@/api/lib/search/extract-content";
import {
  estimateSimilarity,
  lshBandKeys,
  minHashSeeds,
  minHashSignature,
  NEAR_DUPLICATE_THRESHOLD,
  shingleHashes,
} from "@/api/lib/uploads/near-duplicates/minhash";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const CORPUS = new URL("__fixtures__/corpus/", import.meta.url);
const read = async (name: string) =>
  await Bun.file(new URL(`${name}.txt`, CORPUS)).text();

const SEEDS = minHashSeeds("corpus-organization");

const signatureOf = (text: string, seeds = SEEDS): Uint32Array => {
  const signature = minHashSignature(text, seeds);
  if (!signature) {
    throw new Error("expected a signature");
  }
  return signature;
};

const exactJaccard = (left: string, right: string): number => {
  const a = shingleHashes(left) ?? new Set<number>();
  const b = shingleHashes(right) ?? new Set<number>();
  let shared = 0;
  for (const hash of a) {
    if (b.has(hash)) {
      shared++;
    }
  }
  return shared / (a.size + b.size - shared);
};

const compare = (left: string, right: string, seeds = SEEDS) => {
  const a = signatureOf(left, seeds);
  const b = signatureOf(right, seeds);
  const keys = new Set(lshBandKeys(b));
  const candidate = lshBandKeys(a).some((key) => keys.has(key));
  const estimate = estimateSimilarity(a, b);
  return {
    exact: exactJaccard(left, right),
    estimate,
    candidate,
    detected: candidate && estimate >= NEAR_DUPLICATE_THRESHOLD,
  };
};

const lines = (text: string): string[] =>
  text.split("\n").flatMap((line) => {
    const wrapped: string[] = [];
    let current = "";
    for (const word of line.split(" ")) {
      if (current.length + word.length > 90) {
        wrapped.push(current);
        current = word;
      } else {
        current = current === "" ? word : `${current} ${word}`;
      }
    }
    wrapped.push(current);
    return wrapped;
  });

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const docxText = async (text: string): Promise<string> => {
  const zip = new ZipArchive();
  zip.set(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
  );
  zip.set(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text
      .split("\n")
      .map(
        (paragraph) =>
          `<w:p><w:r><w:t xml:space="preserve">${escapeXml(paragraph)}</w:t></w:r></w:p>`,
      )
      .join("")}</w:body></w:document>`,
  );
  const bytes = await zip.generate();
  const extracted = await extractFileTextResult(
    testScannedFile({
      bytes: new Uint8Array(bytes).buffer,
      mimeType: DOCX_MIME_TYPE,
    }),
    { zipNameCodePage: "ibm437" },
  );
  return extracted.unwrap() ?? "";
};

const LINES_PER_PAGE = 50;

const pdfText = async (text: string): Promise<string> => {
  const pdf = PDF.create();
  const all = lines(text);
  for (let start = 0; start < all.length; start += LINES_PER_PAGE) {
    const page = pdf.addPage({ size: "letter" });
    for (const [index, line] of all
      .slice(start, start + LINES_PER_PAGE)
      .entries()) {
      page.drawText(line, {
        x: 54,
        y: 740 - index * 14,
        size: 9,
        font: StandardFonts.Helvetica,
      });
    }
  }
  const extracted = await extractFileTextResult(
    testScannedFile({
      bytes: new Uint8Array(await pdf.save()).buffer,
      mimeType: PDF_MIME_TYPE,
    }),
    { zipNameCodePage: "ibm437" },
  );
  return extracted.unwrap() ?? "";
};

/** Replace `count` words, evenly spread, with one that occurs nowhere else. */
const editWords = (text: string, count: number): string => {
  const parts = text.split(/(\s+)/u);
  const words = parts.flatMap((part, index) =>
    part.trim() === "" ? [] : [index],
  );
  const step = Math.floor(words.length / count);
  const targets = new Set(
    words.filter((_, word) => word % step === 0).slice(0, count),
  );
  expect(targets.size).toBe(count);
  return parts
    .map((part, index) => (targets.has(index) ? "amended" : part))
    .join("");
};

/** Replace the paragraph at `index` with a clause of the same length. */
const changeClause = (text: string, index: number): string => {
  const paragraphs = text.split(/\n\s*\n/u);
  const target = paragraphs[index] ?? "";
  paragraphs[index] = target
    .split(/\s+/u)
    .map((_, word) => `term${word}`)
    .join(" ");
  return paragraphs.join("\n\n");
};

const FAMILIES = [
  "apache-2.0",
  "mpl-2.0",
  "cc0-1.0",
  "blue-oak-1.0.0",
  "psf-2.0",
  "unlicense",
  "isc",
  "bsd-2-clause",
  "mit-express",
];

/** The threshold neighbourhood a pair falls in, by its exact similarity. */
const bucketOf = (exact: number): string | null => {
  if (exact >= 0.67 && exact < 0.73) {
    return "0.70";
  }
  if (exact >= 0.77 && exact < 0.83) {
    return "0.80";
  }
  return null;
};

// Park-Miller generator, so the sweep is the same on every run.
const random = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
};

describe("near-duplicate corpus", () => {
  test("finds every duplicate pair and no unrelated pair", async () => {
    const apache = await read("apache-2.0");
    const mpl = await read("mpl-2.0");
    const cc0 = await read("cc0-1.0");
    const psf = await read("psf-2.0");
    const mit = {
      express: await read("mit-express"),
      commander: await read("mit-commander"),
      jsYaml: await read("mit-js-yaml"),
    };
    const duplicates: [string, string, string][] = [
      ["identical copy (Apache 2.0)", apache, apache],
      [
        "DOCX vs PDF (Apache 2.0)",
        await docxText(apache),
        await pdfText(apache),
      ],
      ["DOCX vs PDF (MPL 2.0)", await docxText(mpl), await pdfText(mpl)],
      ["DOCX vs PDF (CC0 1.0)", await docxText(cc0), await pdfText(cc0)],
      ["10 words edited (Apache 2.0)", apache, editWords(apache, 10)],
      ["30 words edited (MPL 2.0)", mpl, editWords(mpl, 30)],
      ["one changed clause (MPL 2.0)", mpl, changeClause(mpl, 12)],
      ["one changed clause (PSF 2.0)", psf, changeClause(psf, 6)],
      ["MIT, other holder (express/commander)", mit.express, mit.commander],
      ["MIT, other holder (express/js-yaml)", mit.express, mit.jsYaml],
      ["MIT, other holder (commander/js-yaml)", mit.commander, mit.jsYaml],
    ];
    const texts = await Promise.all(
      FAMILIES.map(async (name) => ({ name, text: await read(name) })),
    );
    const unrelated: [string, string, string][] = [];
    for (const [i, left] of texts.entries()) {
      for (const right of texts.slice(i + 1)) {
        unrelated.push([`${left.name} / ${right.name}`, left.text, right.text]);
      }
    }

    const scored = [
      ...duplicates.map(([name, a, b]) => ({
        name,
        duplicate: true,
        ...compare(a, b),
      })),
      ...unrelated.map(([name, a, b]) => ({
        name,
        duplicate: false,
        ...compare(a, b),
      })),
    ];
    for (const row of scored) {
      console.info(
        "near-duplicate-corpus",
        JSON.stringify({
          pair: row.name,
          duplicate: row.duplicate,
          exact: Number(row.exact.toFixed(3)),
          estimate: Number(row.estimate.toFixed(3)),
          candidate: row.candidate,
          detected: row.detected,
        }),
      );
    }
    const truePositives = scored.filter((row) => row.duplicate && row.detected);
    const falsePositives = scored.filter(
      (row) => !row.duplicate && row.detected,
    );
    const precision =
      truePositives.length / (truePositives.length + falsePositives.length);
    const recall = truePositives.length / duplicates.length;
    const maxUnrelated = Math.max(
      ...scored.filter((row) => !row.duplicate).map((row) => row.estimate),
    );
    const minDuplicate = Math.min(
      ...scored.filter((row) => row.duplicate).map((row) => row.estimate),
    );
    console.info(
      "near-duplicate-corpus-summary",
      JSON.stringify({
        duplicates: duplicates.length,
        unrelated: unrelated.length,
        precision,
        recall,
        minDuplicateEstimate: minDuplicate,
        maxUnrelatedEstimate: maxUnrelated,
      }),
    );

    expect(precision).toBe(1);
    expect(recall).toBe(1);
  });

  test("candidate rates near the threshold follow the banding", async () => {
    const base = await read("psf-2.0");
    const words = base.split(/(\s+)/u);
    const draw = random(7);
    const buckets = new Map<string, { pairs: number; candidates: number }>();
    for (let variant = 0; variant < 600; variant++) {
      const edits = 3 + Math.floor(draw() * 28);
      const edited = [...words];
      for (let edit = 0; edit < edits; edit++) {
        edited[Math.floor(draw() * edited.length)] = `edit${variant}x${edit}`;
      }
      const editedText = edited.join("");
      const exact = exactJaccard(base, editedText);
      const bucket = bucketOf(exact);
      if (bucket === null) {
        continue;
      }
      const tally = buckets.get(bucket) ?? { pairs: 0, candidates: 0 };
      tally.pairs++;
      if (compare(base, editedText).candidate) {
        tally.candidates++;
      }
      buckets.set(bucket, tally);
    }
    for (const [bucket, { pairs, candidates }] of buckets) {
      console.info(
        "near-duplicate-banding",
        JSON.stringify({
          exact: bucket,
          pairs,
          candidateRate: candidates / pairs,
        }),
      );
    }
    const at = (bucket: string) => {
      const tally = buckets.get(bucket);
      return tally ? tally.candidates / tally.pairs : 0;
    };
    expect(at("0.70")).toBeGreaterThan(0.8);
    expect(at("0.80")).toBeGreaterThan(0.95);
  });

  test("one license under two holders is found in nearly every organization", async () => {
    const express = await read("mit-express");
    const commander = await read("mit-commander");
    const organizations = 200;
    let detected = 0;
    for (let organization = 0; organization < organizations; organization++) {
      const seeds = minHashSeeds(`corpus-organization-${organization}`);
      if (compare(express, commander, seeds).detected) {
        detected++;
      }
    }
    console.info(
      "near-duplicate-organizations",
      JSON.stringify({
        pair: "MIT, other holder (express/commander)",
        exact: Number(exactJaccard(express, commander).toFixed(3)),
        organizations,
        detectionRate: detected / organizations,
      }),
    );
    expect(detected / organizations).toBeGreaterThan(0.95);
  });
});
