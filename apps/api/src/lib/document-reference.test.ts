import { describe, expect, test } from "bun:test";

import {
  generateVerificationCode,
  toDocumentReference,
} from "@/api/lib/document-reference";

const ALLOWED_CHARS = /^[abcdefghjkmnpqrstuvwxyz23456789]+$/u;

describe("toDocumentReference", () => {
  test("formats with matter ref, padded seq, and version", () => {
    expect(
      toDocumentReference({
        matterReference: "2026/001",
        docSequence: 15,
        versionNumber: 3,
      }),
    ).toBe("2026/001/015.v3");
  });

  test("pads single-digit sequence to 3 chars", () => {
    expect(
      toDocumentReference({
        matterReference: "CORP-001",
        docSequence: 3,
        versionNumber: 1,
      }),
    ).toBe("CORP-001/003.v1");
  });

  test("does not truncate sequence exceeding padding", () => {
    expect(
      toDocumentReference({
        matterReference: "001",
        docSequence: 1234,
        versionNumber: 2,
      }),
    ).toBe("001/1234.v2");
  });

  test("handles version 1", () => {
    expect(
      toDocumentReference({
        matterReference: "2026/001",
        docSequence: 1,
        versionNumber: 1,
      }),
    ).toBe("2026/001/001.v1");
  });

  test("handles bare numeric matter reference", () => {
    expect(
      toDocumentReference({
        matterReference: "001",
        docSequence: 42,
        versionNumber: 2,
      }),
    ).toBe("001/042.v2");
  });
});

describe("generateVerificationCode", () => {
  test("returns a 10-character string", () => {
    const code = generateVerificationCode();
    expect(code).toHaveLength(10);
  });

  test("contains only allowed characters", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateVerificationCode()).toMatch(ALLOWED_CHARS);
    }
  });

  test("generates unique codes", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      codes.add(generateVerificationCode());
    }
    expect(codes.size).toBe(1000);
  });
});
