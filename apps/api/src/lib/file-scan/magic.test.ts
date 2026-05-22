import { describe, expect, test } from "bun:test";

import { declaredMimeMatchesMagic } from "./magic";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

const PDF_HEADER = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);
const PNG_HEADER = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00);
const JPEG_HEADER = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const GIF_89A_HEADER = bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61);
const GIF_87A_HEADER = bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61);
// `RIFF` + 4-byte size + `WEBP`.
const WEBP_HEADER = bytes(
  0x52,
  0x49,
  0x46,
  0x46,
  0x24,
  0x00,
  0x00,
  0x00,
  0x57,
  0x45,
  0x42,
  0x50,
);

describe("declaredMimeMatchesMagic", () => {
  test("known type matches its own magic bytes", () => {
    expect(declaredMimeMatchesMagic("application/pdf", PDF_HEADER)).toBe(true);
    expect(declaredMimeMatchesMagic("image/png", PNG_HEADER)).toBe(true);
    expect(declaredMimeMatchesMagic("image/jpeg", JPEG_HEADER)).toBe(true);
    expect(declaredMimeMatchesMagic("image/gif", GIF_89A_HEADER)).toBe(true);
    expect(declaredMimeMatchesMagic("image/gif", GIF_87A_HEADER)).toBe(true);
    expect(declaredMimeMatchesMagic("image/webp", WEBP_HEADER)).toBe(true);
  });

  test("known type rejects bytes of a different format", () => {
    // A PDF declared as a PNG — the spoof this check exists to catch.
    expect(declaredMimeMatchesMagic("image/png", PDF_HEADER)).toBe(false);
    expect(declaredMimeMatchesMagic("application/pdf", PNG_HEADER)).toBe(false);
    expect(declaredMimeMatchesMagic("image/jpeg", GIF_89A_HEADER)).toBe(false);
  });

  test("GIF requires a full GIF87a or GIF89a header", () => {
    const gif8Spoof = bytes(0x47, 0x49, 0x46, 0x38, 0x00, 0x00);
    expect(declaredMimeMatchesMagic("image/gif", gif8Spoof)).toBe(false);
  });

  test("known type lookup is case-insensitive", () => {
    expect(declaredMimeMatchesMagic("Image/PNG", PNG_HEADER)).toBe(true);
    expect(declaredMimeMatchesMagic("Image/PNG", PDF_HEADER)).toBe(false);
  });

  test("known type lookup strips content type parameters", () => {
    expect(
      declaredMimeMatchesMagic("image/png; charset=utf-8", PNG_HEADER),
    ).toBe(true);
    expect(
      declaredMimeMatchesMagic("Image/PNG ; charset=utf-8", PDF_HEADER),
    ).toBe(false);
  });

  test("WEBP requires the form type at offset 8, not just the RIFF tag", () => {
    // RIFF container that is not WEBP (e.g. a WAV) must not pass.
    const riffWav = bytes(
      0x52,
      0x49,
      0x46,
      0x46,
      0x24,
      0x00,
      0x00,
      0x00,
      0x57,
      0x41,
      0x56,
      0x45,
    );
    expect(declaredMimeMatchesMagic("image/webp", riffWav)).toBe(false);
  });

  test("buffer shorter than the signature does not match", () => {
    expect(declaredMimeMatchesMagic("image/png", bytes(0x89, 0x50))).toBe(
      false,
    );
    expect(declaredMimeMatchesMagic("image/webp", bytes(0x52, 0x49))).toBe(
      false,
    );
  });

  test("unknown / signature-less declared types pass through", () => {
    // Text formats have no reliable magic; the check must not block them.
    expect(declaredMimeMatchesMagic("text/plain", bytes(0x68, 0x69))).toBe(
      true,
    );
    expect(declaredMimeMatchesMagic("text/csv", bytes(0x61, 0x2c, 0x62))).toBe(
      true,
    );
    expect(declaredMimeMatchesMagic("image/svg+xml", bytes(0x3c, 0x73))).toBe(
      true,
    );
  });
});
