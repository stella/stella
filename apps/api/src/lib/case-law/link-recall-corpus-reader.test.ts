import { expect, test } from "bun:test";

import { PayloadBudgetError, zstdCompress } from "@/api/lib/compression";
import { corpusMemberDigest } from "@/api/lib/legal-search/corpus-pack";

import {
  LinkRecallPayloadError,
  readLinkRecallPayload,
} from "./link-recall-corpus-reader";

const errorOf = (result: Awaited<ReturnType<typeof readLinkRecallPayload>>) =>
  result.isErr() ? result.error : undefined;

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
  ).toMatchObject({ status: "ok", value: payload });
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
  ).toMatchObject({ status: "ok", value: '{"paragraphs":["Ve věci"]}' });
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
    const error = errorOf(
      await readLinkRecallPayload({
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
  const error = errorOf(
    await readLinkRecallPayload({
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
    const error = errorOf(
      await readLinkRecallPayload({
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
  const transferred = errorOf(
    await readLinkRecallPayload({
      location: "large.zst",
      readObject: async () => new Uint8Array(4097),
      ...budgets,
    }),
  );
  expect(transferred).toBeInstanceOf(PayloadBudgetError);
  const bytes = zstdCompress("x".repeat(100_000));
  expect(bytes.byteLength).toBeLessThan(budgets.maxCompressedBytes);
  const decompressed = errorOf(
    await readLinkRecallPayload({
      location: "bomb.zst",
      readObject: async () => bytes,
      ...budgets,
    }),
  );
  expect(decompressed).toBeInstanceOf(PayloadBudgetError);
});

test("audit reader errors preserve object rejection causes and existing tagged errors", async () => {
  for (const failure of [
    new LinkRecallPayloadError({ message: "Read failed" }),
    new PayloadBudgetError({ message: "Read overflow" }),
  ]) {
    const result = await readLinkRecallPayload({
      location: "object.zst",
      readObject: async () => await Promise.reject(failure),
      ...budgets,
    });
    expect(errorOf(result)).toBe(failure);
  }
  const cause = new TypeError("Storage unavailable");
  const result = await readLinkRecallPayload({
    location: "object.zst",
    readObject: async () => await Promise.reject(cause),
    ...budgets,
  });
  expect(errorOf(result)).toMatchObject({
    message: "Audit corpus object could not be read",
    cause,
  });
});

test("audit readers return malformed locations and invalid budgets without reading an object", async () => {
  const requests: unknown[] = [];
  const readObject = async (request: unknown) => {
    requests.push(request);
    return new Uint8Array();
  };
  for (const location of [
    "pack:malformed",
    `pack:pack.stlpack@${Number.MAX_SAFE_INTEGER}0+1#${"a".repeat(64)}`,
  ]) {
    const result = await readLinkRecallPayload({
      location,
      readObject,
      ...budgets,
    });
    expect(errorOf(result)).toMatchObject({
      message: "Audit corpus location could not be parsed",
      cause: expect.any(Error),
    });
  }
  for (const invalid of [
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    for (const limits of [
      { maxCompressedBytes: invalid, maxDecompressedBytes: 4096 },
      { maxCompressedBytes: 4096, maxDecompressedBytes: invalid },
    ]) {
      const result = await readLinkRecallPayload({
        location: "object.zst",
        readObject,
        ...limits,
      });
      expect(errorOf(result)).toMatchObject({
        message: expect.stringContaining("positive safe integers"),
      });
    }
  }
  expect(requests).toEqual([]);
});

test("corrupt compressed bytes resolve to a tagged reader error with the decompressor cause", async () => {
  const result = await readLinkRecallPayload({
    location: "corrupt.zst",
    readObject: async () => new Uint8Array([1, 2, 3]),
    ...budgets,
  });
  expect(errorOf(result)).toMatchObject({
    message: "Audit corpus payload could not be decompressed",
    cause: expect.any(Error),
  });
});
