import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { PayloadBudgetError, zstdCompress } from "@/api/lib/compression";
import { corpusMemberDigest } from "@/api/lib/legal-search/corpus-pack";

import {
  LinkRecallPayloadError,
  readLinkRecallPayload,
} from "./link-recall-corpus-reader";

const budgets = { maxCompressedBytes: 4096, maxDecompressedBytes: 4096 };

test("audit corpus reads decode plain objects as text without requiring JSON", async () => {
  const payload = "Žalobce odkazuje na rozsudek 6 As 1/2024.\n😀";
  const bytes = zstdCompress(payload);
  const requests: unknown[] = [];
  expect(
    await readLinkRecallPayload({
      location: "corpus/text.zst",
      readObject: async (request) => {
        requests.push(request);
        return bytes;
      },
      ...budgets,
    }),
  ).toBe(payload);
  expect(requests).toEqual([{ key: "corpus/text.zst" }]);
});

test("audit packed reads request and verify precisely the declared member", async () => {
  const bytes = zstdCompress('{"paragraphs":["Ve věci"]}');
  const location = `pack:corpus/pack.stlpack@41+${bytes.byteLength}#${corpusMemberDigest(bytes)}`;
  const requests: unknown[] = [];
  expect(
    await readLinkRecallPayload({
      location,
      readObject: async (request) => {
        requests.push(request);
        return bytes;
      },
      ...budgets,
    }),
  ).toBe('{"paragraphs":["Ve věci"]}');
  expect(requests).toEqual([
    {
      key: "corpus/pack.stlpack",
      range: { offset: 41, length: bytes.byteLength },
    },
  ]);
});

test("audit packed reads reject truncated overlong and tampered members", async () => {
  const bytes = zstdCompress("Expected corpus member");
  const tampered = Uint8Array.from(bytes);
  const last = tampered.at(-1);
  expect(last).toBeDefined();
  if (last === undefined) {
    throw new LinkRecallPayloadError({
      message: "Compressed test fixture is empty",
    });
  }
  tampered[tampered.length - 1] = last === 0 ? 1 : 0;
  expect(corpusMemberDigest(tampered)).not.toBe(corpusMemberDigest(bytes));
  for (const [response, message] of [
    [bytes.slice(1), "range length"],
    [new Uint8Array(bytes.byteLength + 1), "range length"],
    [tampered, "digest"],
  ] as const) {
    const error = await rejectionOf(
      readLinkRecallPayload({
        location: `pack:pack.stlpack@2+${bytes.byteLength}#${corpusMemberDigest(bytes)}`,
        readObject: async () => response,
        ...budgets,
      }),
    );
    expect(error).toBeInstanceOf(LinkRecallPayloadError);
    expect(error).toMatchObject({ message: expect.stringContaining(message) });
  }
});

test("audit reads reject oversized declared ranges before requesting any bytes", async () => {
  const requests: unknown[] = [];
  const error = await rejectionOf(
    readLinkRecallPayload({
      location: `pack:pack.stlpack@0+4097#${"a".repeat(64)}`,
      readObject: async (request) => {
        requests.push(request);
        return new Uint8Array();
      },
      ...budgets,
    }),
  );
  expect(error).toBeInstanceOf(PayloadBudgetError);
  expect(requests).toEqual([]);
});

test("audit reads reject empty and overflowing packed address ranges", async () => {
  for (const range of ["0+0", `${Number.MAX_SAFE_INTEGER}+2`]) {
    const error = await rejectionOf(
      readLinkRecallPayload({
        location: `pack:pack.stlpack@${range}#${"a".repeat(64)}`,
        readObject: async () => new Uint8Array(),
        ...budgets,
      }),
    );
    expect(error).toBeInstanceOf(LinkRecallPayloadError);
    expect(error).toMatchObject({
      message: expect.stringContaining("invalid byte range"),
    });
  }
});

test("audit reads bound transferred and decompressed payloads independently", async () => {
  const transferred = await rejectionOf(
    readLinkRecallPayload({
      location: "large.zst",
      readObject: async () => new Uint8Array(4097),
      ...budgets,
    }),
  );
  expect(transferred).toBeInstanceOf(PayloadBudgetError);
  const bytes = zstdCompress("x".repeat(100_000));
  expect(bytes.byteLength).toBeLessThan(budgets.maxCompressedBytes);
  const decompressed = await rejectionOf(
    readLinkRecallPayload({
      location: "bomb.zst",
      readObject: async () => bytes,
      ...budgets,
    }),
  );
  expect(decompressed).toBeInstanceOf(PayloadBudgetError);
});
