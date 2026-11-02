import { Panic, panic } from "better-result";
import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { PayloadBudgetError, zstdCompress } from "@/api/lib/compression";
import { corpusMemberDigest } from "@/api/lib/legal-search/corpus-pack";

import {
  LinkRecallPayloadError,
  readLinkRecallPayload,
} from "./link-recall-corpus-reader";

const budgets = { maxCompressedBytes: 4096, maxDecompressedBytes: 4096 };

test("audit reads pass tagged reader errors through with their identity", async () => {
  for (const failure of [
    new LinkRecallPayloadError({ message: "Object unavailable" }),
    new PayloadBudgetError({ message: "Read overflow" }),
  ]) {
    const result = await readLinkRecallPayload({
      location: "corpus/text.zst",
      readObject: async () => await Promise.reject(failure),
      ...budgets,
    });
    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      panic("Expected audit read failure");
    }
    expect(result.error).toBe(failure);
  }
});

test("audit reads wrap unknown read and decode failures with their cause", async () => {
  const cause = new TypeError("Storage unavailable");
  const unreadable = await readLinkRecallPayload({
    location: "corpus/text.zst",
    readObject: async () => await Promise.reject(cause),
    ...budgets,
  });
  expect(unreadable.isErr()).toBe(true);
  if (unreadable.isOk()) {
    panic("Expected audit read failure");
  }
  expect(unreadable.error).toBeInstanceOf(LinkRecallPayloadError);
  expect(unreadable.error).toMatchObject({
    message: "Audit corpus object could not be read",
    cause,
  });
  const undecodable = await readLinkRecallPayload({
    location: "corpus/text.zst",
    readObject: async () => new Uint8Array([0, 1, 2]),
    ...budgets,
  });
  expect(undecodable.isErr()).toBe(true);
  if (undecodable.isOk()) {
    panic("Expected audit decode failure");
  }
  expect(undecodable.error).toBeInstanceOf(LinkRecallPayloadError);
  expect(undecodable.error).toMatchObject({
    message: "Audit corpus payload could not be decompressed",
    cause: expect.any(Error),
  });
});

test("audit reads panic on corrupt corpus locations before reading an object", async () => {
  const requests: unknown[] = [];
  for (const [location, message] of [
    ["pack:malformed", "Malformed packed corpus address"],
    [
      `pack:pack.stlpack@${Number.MAX_SAFE_INTEGER}0+1#${"a".repeat(64)}`,
      "unrepresentable integer",
    ],
  ] as const) {
    const failure = await rejectionOf(
      readLinkRecallPayload({
        location,
        readObject: async (request) => {
          requests.push(request);
          return new Uint8Array();
        },
        ...budgets,
      }),
    );
    expect(failure).toBeInstanceOf(Panic);
    expect(failure).toMatchObject({
      message: expect.stringContaining(message),
    });
  }
  expect(requests).toEqual([]);
});

test("audit reads panic on invalid budgets before reading an object", async () => {
  const requests: unknown[] = [];
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
      const failure = await rejectionOf(
        readLinkRecallPayload({
          location: "corpus/text.zst",
          readObject: async (request) => {
            requests.push(request);
            return new Uint8Array();
          },
          ...limits,
        }),
      );
      expect(failure).toBeInstanceOf(Panic);
      expect(failure).toMatchObject({
        message: expect.stringContaining("positive safe integers"),
      });
    }
  }
  expect(requests).toEqual([]);
});

test("audit corpus reads decode plain objects as text without requiring JSON", async () => {
  const payload = "Žalobce odkazuje na rozsudek 6 As 1/2024.\n😀";
  const bytes = zstdCompress(payload);
  const requests: unknown[] = [];
  expect(
    (
      await readLinkRecallPayload({
        location: "corpus/text.zst",
        readObject: async (request) => {
          requests.push(request);
          return bytes;
        },
        ...budgets,
      })
    ).unwrap(),
  ).toBe(payload);
  expect(requests).toEqual([{ key: "corpus/text.zst" }]);
});

test("audit packed reads request and verify precisely the declared member", async () => {
  const bytes = zstdCompress('{"paragraphs":["Ve věci"]}');
  const location = `pack:corpus/pack.stlpack@41+${bytes.byteLength}#${corpusMemberDigest(bytes)}`;
  const requests: unknown[] = [];
  expect(
    (
      await readLinkRecallPayload({
        location,
        readObject: async (request) => {
          requests.push(request);
          return bytes;
        },
        ...budgets,
      })
    ).unwrap(),
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
    panic("Compressed test fixture is empty");
  }
  tampered[tampered.length - 1] = last === 0 ? 1 : 0;
  expect(corpusMemberDigest(tampered)).not.toBe(corpusMemberDigest(bytes));
  for (const [response, message] of [
    [bytes.slice(1), "range length"],
    [new Uint8Array(bytes.byteLength + 1), "range length"],
    [tampered, "digest"],
  ] as const) {
    const error = await readLinkRecallPayload({
      location: `pack:pack.stlpack@2+${bytes.byteLength}#${corpusMemberDigest(bytes)}`,
      readObject: async () => response,
      ...budgets,
    });
    expect(error.isErr()).toBe(true);
    if (error.isOk()) {
      panic("Expected audit read to fail");
    }
    expect(error.error).toBeInstanceOf(LinkRecallPayloadError);
    expect(error.error).toMatchObject({
      message: expect.stringContaining(message),
    });
  }
});

test("audit reads reject oversized declared ranges before requesting any bytes", async () => {
  const requests: unknown[] = [];
  const error = await readLinkRecallPayload({
    location: `pack:pack.stlpack@0+4097#${"a".repeat(64)}`,
    readObject: async (request) => {
      requests.push(request);
      return new Uint8Array();
    },
    ...budgets,
  });
  expect(error.isErr()).toBe(true);
  if (error.isOk()) {
    panic("Expected audit read to fail");
  }
  expect(error.error).toBeInstanceOf(PayloadBudgetError);
  expect(requests).toEqual([]);
});

test("audit reads reject empty and overflowing packed address ranges", async () => {
  for (const range of ["0+0", `${Number.MAX_SAFE_INTEGER}+2`]) {
    const error = await readLinkRecallPayload({
      location: `pack:pack.stlpack@${range}#${"a".repeat(64)}`,
      readObject: async () => new Uint8Array(),
      ...budgets,
    });
    expect(error.isErr()).toBe(true);
    if (error.isOk()) {
      panic("Expected audit read to fail");
    }
    expect(error.error).toBeInstanceOf(LinkRecallPayloadError);
    expect(error.error).toMatchObject({
      message: expect.stringContaining("invalid byte range"),
    });
  }
});

test("audit reads bound transferred and decompressed payloads independently", async () => {
  const transferred = await readLinkRecallPayload({
    location: "large.zst",
    readObject: async () => new Uint8Array(4097),
    ...budgets,
  });
  expect(transferred.isErr()).toBe(true);
  if (transferred.isOk()) {
    panic("Expected transfer budget failure");
  }
  expect(transferred.error).toBeInstanceOf(PayloadBudgetError);
  const bytes = zstdCompress("x".repeat(100_000));
  expect(bytes.byteLength).toBeLessThan(budgets.maxCompressedBytes);
  const decompressed = await readLinkRecallPayload({
    location: "bomb.zst",
    readObject: async () => bytes,
    ...budgets,
  });
  expect(decompressed.isErr()).toBe(true);
  if (decompressed.isOk()) {
    panic("Expected decompression budget failure");
  }
  expect(decompressed.error).toBeInstanceOf(PayloadBudgetError);
});
