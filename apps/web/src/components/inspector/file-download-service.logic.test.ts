import { describe, expect, test } from "bun:test";

import { DOCUMENT_PROPERTIES_MAX_BYTES } from "@stll/api-contract";

import {
  canDownloadScrubbed,
  getDownloadRenditions,
  getPdfDownloadFileName,
} from "@/components/inspector/file-download-service.logic";
import { DOCX_MIME, PDF_MIME } from "@/lib/consts";

const NOTHING_AVAILABLE = {
  canScrub: false,
  currentVersionReference: null,
  encrypted: false,
  hasPdfConversion: false,
  mimeType: DOCX_MIME,
};

describe("download renditions", () => {
  test("offers the reference copy of a readable DOCX whose version is referenced", () => {
    expect(
      getDownloadRenditions({
        ...NOTHING_AVAILABLE,
        currentVersionReference: "2026/001/015.v3",
      }),
    ).toEqual(["reference"]);
  });

  // The matter's own reference is not the signal: a version created before
  // the matter got one is stamped null, and the server refuses to build a
  // reference copy of it.
  test("offers no reference copy when the version carries none or none is resolved yet", () => {
    for (const currentVersionReference of [null, undefined, ""]) {
      expect(
        getDownloadRenditions({
          ...NOTHING_AVAILABLE,
          currentVersionReference,
        }),
      ).toEqual([]);
    }
  });

  test("offers no reference copy for formats that cannot carry one", () => {
    for (const mimeType of [PDF_MIME, "text/plain", undefined]) {
      expect(
        getDownloadRenditions({
          ...NOTHING_AVAILABLE,
          currentVersionReference: "2026/001/015.v3",
          mimeType,
        }),
      ).toEqual([]);
    }
  });

  test("offers no reference copy when the bytes are encrypted or unresolved", () => {
    for (const encrypted of [true, undefined]) {
      expect(
        getDownloadRenditions({
          ...NOTHING_AVAILABLE,
          currentVersionReference: "2026/001/015.v3",
          encrypted,
        }),
      ).toEqual([]);
    }
  });

  test("lists every available rendition in one fixed order", () => {
    expect(
      getDownloadRenditions({
        canScrub: true,
        currentVersionReference: "2026/001/015.v3",
        encrypted: false,
        hasPdfConversion: true,
        mimeType: DOCX_MIME,
      }),
    ).toEqual(["reference", "pdf", "scrubbed"]);
  });

  test("offers the renditions a non-referenceable file still has", () => {
    expect(
      getDownloadRenditions({
        ...NOTHING_AVAILABLE,
        canScrub: true,
        hasPdfConversion: true,
        mimeType: "image/png",
      }),
    ).toEqual(["pdf", "scrubbed"]);
  });
});

describe("scrubbed download eligibility", () => {
  test("rejects files the server cannot scrub", () => {
    expect(
      canDownloadScrubbed({
        encrypted: false,
        mimeType: "application/pdf",
        sizeBytes: DOCUMENT_PROPERTIES_MAX_BYTES,
      }),
    ).toBe(true);
    expect(
      canDownloadScrubbed({
        encrypted: true,
        mimeType: "application/pdf",
        sizeBytes: 1,
      }),
    ).toBe(false);
    expect(
      canDownloadScrubbed({
        encrypted: false,
        mimeType: "application/pdf",
        sizeBytes: DOCUMENT_PROPERTIES_MAX_BYTES + 1,
      }),
    ).toBe(false);
    expect(
      canDownloadScrubbed({
        encrypted: false,
        mimeType: "text/plain",
        sizeBytes: 1,
      }),
    ).toBe(false);
  });
});

describe("save-as-PDF download filenames", () => {
  test("uses the source document base name with a PDF extension", () => {
    expect(getPdfDownloadFileName("Contract.docx")).toBe("Contract.pdf");
    expect(getPdfDownloadFileName("Contract.v2.DOCX")).toBe("Contract.v2.pdf");
  });

  test("appends the PDF extension when the source has no extension", () => {
    expect(getPdfDownloadFileName("Contract")).toBe("Contract.pdf");
  });

  test("does not treat a leading dot as a removable extension", () => {
    expect(getPdfDownloadFileName(".contract")).toBe(".contract.pdf");
  });
});
