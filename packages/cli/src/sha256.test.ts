import { expect, test } from "bun:test";

import { sha256Base64Url, sha256Hex } from "./sha256";

const vectors = [
  {
    input: "",
    hex: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  {
    input: "abc",
    hex: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  },
  {
    input: new Uint8Array([0, 255, 1, 128]),
    hex: "edc81f7e4ee358fb91e94bd9bd74079c3dcba36f40f2c8a36e7ae0567afecc8f",
  },
];

test("CLI hashing preserves known vectors and unpadded base64url", () => {
  for (const { input, hex } of vectors) {
    expect(sha256Hex(input)).toBe(hex);
    expect(sha256Base64Url(input)).toBe(
      Buffer.from(hex, "hex").toString("base64url"),
    );
    expect(sha256Base64Url(input)).not.toContain("=");
  }
});

test("CLI hashing uses UTF-8 and respects byte-view boundaries", () => {
  const text = "Příliš žluťoučký kůň 🧑‍⚖️ 中文\u0000\ud800";
  const bytes = new TextEncoder().encode(text);
  const storage = new Uint8Array(bytes.length + 12).fill(255);
  storage.set(bytes, 5);
  const view = storage.subarray(5, 5 + bytes.length);
  expect(view.byteOffset).toBe(5);
  expect(sha256Hex(storage)).not.toBe(sha256Hex(bytes));
  expect(sha256Hex(text)).toBe(sha256Hex(bytes));
  expect(sha256Hex(view)).toBe(sha256Hex(bytes));
  expect(sha256Base64Url(view)).toBe(sha256Base64Url(bytes));
});
