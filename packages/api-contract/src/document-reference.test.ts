import { describe, expect, test } from "bun:test";

import {
  documentReferenceBase,
  isDocumentReferenceQuery,
  isVerificationCode,
  VERIFICATION_CODE_ALPHABET,
  VERIFICATION_CODE_LENGTH,
  VERIFICATION_CODE_PATTERN,
} from "./document-reference";

const FROZEN = [
  "Changing the verification-code alphabet or length retires every reference",
  "already printed into a document outside the product: those files cannot be",
  "reissued, so their codes would stop parsing and resolving. Accept a further",
  "format alongside this one instead of altering this one.",
].join(" ");

describe("verification code contract", () => {
  // The literals are spelled out rather than derived, so editing the constant
  // fails here instead of silently redefining the printed format.
  test("alphabet and length are frozen", () => {
    expect(VERIFICATION_CODE_ALPHABET, FROZEN).toBe(
      "abcdefghjkmnpqrstuvwxyz23456789",
    );
    expect(VERIFICATION_CODE_LENGTH, FROZEN).toBe(10);
    expect(VERIFICATION_CODE_PATTERN, FROZEN).toBe(
      "^[abcdefghjkmnpqrstuvwxyz23456789]{10}$",
    );
  });
});

describe("isVerificationCode", () => {
  test("accepts a ten-character code from the printed alphabet", () => {
    expect(isVerificationCode("abcdmnp239")).toBe(true);
  });

  test.each([
    ["abcdmnp230"], // 0 and O read alike
    ["abcdmnp23o"],
    ["abcdmnp23O"],
    ["abcdmnp231"], // 1, l and I read alike
    ["abcdmnp23l"],
    ["abcdmnp23I"],
    ["ABCDMNP239"], // codes are printed lowercase
    ["abcdmnp23"], // nine characters
    ["abcdmnp2399"], // eleven characters
    [""],
    ["abcdmnp23-"],
    ["abcd mnp23"],
  ])("rejects %p", (code) => {
    expect(isVerificationCode(code)).toBe(false);
  });
});

describe("isDocumentReferenceQuery", () => {
  test.each([
    ["2026/001/015"],
    ["2026/001/015.v3"],
    ["2026/001/015.v12"],
    // The matter reference is free-form: any shape, with or without slashes.
    ["AB/12/001"],
    ["contracts/001"],
  ])("accepts %p", (query) => {
    expect(isDocumentReferenceQuery(query)).toBe(true);
  });

  test.each([
    ["2026"], // no sequence segment
    ["report/1"], // an unpadded number is not a sequence
    ["two words/001"], // a reference is one token
    ["minutes.docx"], // a file name, not a reference
    ["2026/001/015.docx"], // a reference-looking file name
    ["/001"], // no matter reference in front
    ["2026/001/0"], // still being typed
    [""],
  ])("rejects %p", (query) => {
    expect(isDocumentReferenceQuery(query)).toBe(false);
  });

  // Both halves read the same grammar: a stamp is a reference query, and so is
  // what stripping its version suffix leaves.
  test("accepts a stamp and its version-less base alike", () => {
    const stamp = "2026/001/015.v3";
    expect(documentReferenceBase(stamp)).not.toBe(stamp);
    expect(isDocumentReferenceQuery(stamp)).toBe(true);
    expect(isDocumentReferenceQuery(documentReferenceBase(stamp))).toBe(true);
  });
});
