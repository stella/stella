import { expect, test } from "bun:test";

import * as browser from "./browser.ts";
import * as bun from "./bun.ts";
import { sha256Base64ToHex, sha256HexToBase64 } from "./encoding.ts";
import * as node from "./node.ts";

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

test("all runtime owners preserve known SHA-256 vectors and encodings", async () => {
  for (const { input, hex } of vectors) {
    const bytes = Buffer.from(hex, "hex");
    for (const owner of [bun, node]) {
      expect(owner.sha256Hex(input)).toBe(hex);
      expect(owner.sha256Base64(input)).toBe(bytes.toString("base64"));
      expect(owner.sha256Base64Url(input)).toBe(bytes.toString("base64url"));
      const actual = owner.sha256Bytes(input);
      expect(Buffer.isBuffer(actual)).toBe(true);
      expect(actual).toEqual(bytes);
      expect(actual.readUInt32BE(0)).toBe(bytes.readUInt32BE(0));
    }
    expect(await browser.sha256Hex(input)).toBe(hex);
    expect(new Uint8Array(await browser.sha256Bytes(input))).toEqual(
      new Uint8Array(bytes),
    );
    expect(sha256HexToBase64(hex)).toBe(bytes.toString("base64"));
    expect(sha256Base64ToHex(bytes.toString("base64"))).toBe(hex);
  }
});

test("strings hash UTF-8 and byte views hash only the selected bytes", async () => {
  const text = "Příliš žluťoučký kůň 🧑‍⚖️ 中文\u0000\ud800";
  const utf8 = new TextEncoder().encode(text);
  const storage = new Uint8Array(utf8.length + 12).fill(255);
  storage.set(utf8, 5);
  const view = storage.subarray(5, 5 + utf8.length);
  expect(view.byteOffset).toBe(5);
  expect(node.sha256Hex(storage)).not.toBe(node.sha256Hex(utf8));
  for (const owner of [bun, node]) {
    expect(owner.sha256Hex(text)).toBe(node.sha256Hex(utf8));
    expect(owner.sha256Hex(view)).toBe(node.sha256Hex(utf8));
    expect(owner.sha256Hex(Buffer.from(view))).toBe(node.sha256Hex(utf8));
  }
  expect(await browser.sha256Hex(text)).toBe(node.sha256Hex(utf8));
  expect(await browser.sha256Hex(view)).toBe(node.sha256Hex(utf8));
  expect(await browser.sha256Hex(utf8.buffer)).toBe(node.sha256Hex(utf8));
  expect(await browser.sha256Hex(new Blob([view]))).toBe(node.sha256Hex(utf8));
  expect(
    new Uint8Array(await browser.sha256Bytes(new File([view], "selected.bin"))),
  ).toEqual(new Uint8Array(node.sha256Bytes(utf8)));
});

test("incremental hashing preserves large chunked byte streams and update order", async () => {
  const bytes = Uint8Array.from(
    { length: 1_048_579 },
    (_, index) => index % 251,
  );
  const hex = node.sha256Hex(bytes);
  for (const owner of [bun, node]) {
    const hasher = owner.createSha256();
    expect(hasher.update(new Uint8Array())).toBe(hasher);
    for (let offset = 0; offset < bytes.length; offset += 4093) {
      expect(hasher.update(bytes.subarray(offset, offset + 4093))).toBe(hasher);
    }
    expect(hasher.digest("hex")).toBe(hex);
    expect(
      owner
        .createSha256()
        .update("ab", "utf-8")
        .update("c", "utf-8")
        .digest("hex"),
    ).toBe(node.sha256Hex("abc"));
    expect(
      owner.createSha256().update("c").update("ab").digest("hex"),
    ).not.toBe(node.sha256Hex("abc"));
    expect(owner.createSha256().update(bytes).digest()).toEqual(
      node.sha256Bytes(bytes),
    );
    for (const encoding of ["hex", "base64", "base64url"] as const) {
      expect(owner.createSha256().update(bytes).digest(encoding)).toBe(
        node.sha256Bytes(bytes).toString(encoding),
      );
    }
  }
  expect(await browser.sha256Hex(bytes)).toBe(hex);
});

type BlobReadLedger = {
  /** Reads of the whole Blob through any body accessor. */
  wholeReads: number;
  /** Byte ranges read through slices, in read order. */
  ranges: [start: number, end: number][];
  /** Most bytes one read handed to the hasher at once. */
  peakHeldBytes: number;
};

const emptyLedger = (): BlobReadLedger => ({
  wholeReads: 0,
  ranges: [],
  peakHeldBytes: 0,
});

// A selected File as the upload path sees it: every way of reading its bytes
// is counted, so a pass that reads the whole body or a range twice shows up.
const countingBlob = (bytes: Uint8Array, ledger: BlobReadLedger): Blob => {
  class CountingSlice extends Blob {
    readonly range: [number, number];
    constructor(parts: BlobPart[], range: [number, number]) {
      super(parts);
      this.range = range;
    }
    override async arrayBuffer(): Promise<ArrayBuffer> {
      ledger.ranges.push(this.range);
      ledger.peakHeldBytes = Math.max(ledger.peakHeldBytes, this.size);
      return await super.arrayBuffer();
    }
  }
  class CountingBlob extends Blob {
    override async arrayBuffer(): Promise<ArrayBuffer> {
      ledger.wholeReads += 1;
      ledger.peakHeldBytes = Math.max(ledger.peakHeldBytes, this.size);
      return await super.arrayBuffer();
    }
    override async bytes(): Promise<Uint8Array<ArrayBuffer>> {
      ledger.wholeReads += 1;
      ledger.peakHeldBytes = Math.max(ledger.peakHeldBytes, this.size);
      return await super.bytes();
    }
    override async text(): Promise<string> {
      ledger.wholeReads += 1;
      return await super.text();
    }
    override stream(): ReadableStream<Uint8Array<ArrayBuffer>> {
      ledger.wholeReads += 1;
      return super.stream();
    }
    override slice(start = 0, end = this.size): Blob {
      const clampedEnd = Math.min(end, this.size);
      return new CountingSlice(
        [super.slice(start, clampedEnd)],
        [start, clampedEnd],
      );
    }
  }
  return new CountingBlob([Uint8Array.from(bytes)]);
};

test("a Blob is hashed in one front-to-back pass of bounded chunks at any size", async () => {
  const smallSize = browser.BLOB_HASH_CHUNK_BYTES * 2 + 7;
  for (const size of [
    1,
    browser.BLOB_HASH_CHUNK_BYTES - 1,
    browser.BLOB_HASH_CHUNK_BYTES,
    browser.BLOB_HASH_CHUNK_BYTES + 1,
    smallSize,
    smallSize * 10,
  ]) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
    const ledger = emptyLedger();

    expect(await browser.sha256Hex(countingBlob(bytes, ledger))).toBe(
      node.sha256Hex(bytes),
    );

    expect(ledger.wholeReads).toBe(0);
    expect(ledger.peakHeldBytes).toBe(
      Math.min(size, browser.BLOB_HASH_CHUNK_BYTES),
    );
    // Contiguous, non-overlapping ranges that cover every byte exactly once.
    let next = 0;
    for (const [start, end] of ledger.ranges) {
      expect(start).toBe(next);
      expect(end).toBeGreaterThan(start);
      next = end;
    }
    expect(next).toBe(size);
    expect(ledger.ranges).toHaveLength(
      Math.ceil(size / browser.BLOB_HASH_CHUNK_BYTES),
    );
  }

  const ledger = emptyLedger();
  expect(await browser.sha256Hex(countingBlob(new Uint8Array(), ledger))).toBe(
    node.sha256Hex(""),
  );
  expect(ledger).toEqual(emptyLedger());
});
