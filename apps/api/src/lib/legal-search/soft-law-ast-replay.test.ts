import { expect, test } from "bun:test";

import { sha256Hex } from "@stll/sha256/bun";

import { toSafeId } from "@/api/lib/branded-types";

import { loadSoftLawAstRaw } from "./soft-law-ast-replay";

const sourceId = toSafeId<"softLawSource">(
  "019a10d0-0000-7000-8000-000000000001",
);
const bytes = new TextEncoder().encode("<p>Retained synthetic guidance.</p>");
const original = {
  key: `soft-law/raw/${sourceId}/${sha256Hex(bytes)}`,
  role: "document",
  purpose: "document",
  contentType: "text/html",
} as const;
const signal = new AbortController().signal;

test("retained replay originals preserve bytes and provenance", async () => {
  const result = await loadSoftLawAstRaw({
    sourceId,
    rawObjects: [original],
    signal,
    readRaw: async () => bytes,
  });
  expect(result.status).toBe("ok");
  if (result.status === "ok") {
    expect(result.value).toEqual([
      {
        role: original.role,
        purpose: original.purpose,
        contentType: original.contentType,
        bytes,
      },
    ]);
  }
});

test("replay rejects another source before opening an object", async () => {
  let reads = 0;
  const result = await loadSoftLawAstRaw({
    sourceId,
    rawObjects: [
      {
        ...original,
        key: original.key.replace(
          sourceId,
          "019a10d0-0000-7000-8000-000000000002",
        ),
      },
    ],
    signal,
    readRaw: async () => {
      reads++;
      return bytes;
    },
  });
  expect(result.status).toBe("error");
  expect(reads).toBe(0);
});

test("replay refuses missing or changed original bytes and propagates storage failure", async () => {
  for (const readRaw of [
    async () => null,
    async () => new Uint8Array([1]),
    async () => {
      throw new TypeError("synthetic read failure");
    },
  ]) {
    const result = await loadSoftLawAstRaw({
      sourceId,
      rawObjects: [original],
      signal,
      readRaw,
    });
    expect(result.status).toBe("error");
  }
});

test("replay enforces one shared byte budget and a bounded original count", async () => {
  const ceilings: number[] = [];
  const result = await loadSoftLawAstRaw({
    sourceId,
    rawObjects: [original, { ...original, role: "page", purpose: "discovery" }],
    signal,
    readRaw: async ({ maxBytes }) => {
      ceilings.push(maxBytes);
      return bytes;
    },
  });
  expect(result.status).toBe("ok");
  expect(ceilings).toEqual([
    64 * 1024 * 1024,
    64 * 1024 * 1024 - bytes.byteLength,
  ]);
  let reads = 0;
  const oversized = await loadSoftLawAstRaw({
    sourceId,
    rawObjects: Array.from({ length: 21 }, () => original),
    signal,
    readRaw: async () => {
      reads++;
      return bytes;
    },
  });
  expect(oversized.status).toBe("error");
  expect(reads).toBe(0);
});
