import { describe, expect, test } from "bun:test";

import { sleep } from "@stll/concurrency/sleep";

import {
  settleBoth,
  splitIngestRequests,
  type IngestRequest,
} from "@/api/lib/corpus-index/core";

/**
 * A batch is sized in rows, but a passage family turns one row into as many
 * documents as it has passages, so the NDJSON body a batch serializes to is
 * not bounded by the row count. These tests pin the byte bound and document
 * order when a row spans multiple requests.
 */

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf-8");

const builtRow = (id: string, passages: number, filler: string) => ({
  row: { id },
  docs: Array.from({ length: passages }, (_, seq) => ({
    document_id: id,
    seq,
    text: filler,
  })),
});

const ingestedIds = (requests: IngestRequest<unknown>[]) =>
  requests.flatMap(({ ndjson }) =>
    ndjson.split("\n").map((line) => {
      const doc: Record<string, unknown> = JSON.parse(line);
      return `${String(doc["document_id"])}:${String(doc["seq"])}`;
    }),
  );

describe("splitIngestRequests", () => {
  test("a group that fits stays one request", () => {
    const group = [builtRow("a", 3, "x"), builtRow("b", 2, "x")];

    const requests = splitIngestRequests(group, 1_000_000).unwrap();

    expect(requests).toHaveLength(1);
    expect(requests.at(0)?.entries).toHaveLength(2);
    expect(requests.at(0)?.ndjson.split("\n")).toHaveLength(5);
  });

  test("every document is sent exactly once, in order, across the split", () => {
    const group = [
      builtRow("a", 4, "x".repeat(400)),
      builtRow("b", 4, "x".repeat(400)),
      builtRow("c", 4, "x".repeat(400)),
    ];

    const requests = splitIngestRequests(group, 2000).unwrap();

    expect(requests.length).toBeGreaterThan(1);
    // No document dropped, none duplicated, document order preserved — the
    // indexer marks a row indexed on the strength of this.
    expect(ingestedIds(requests)).toEqual([
      ...["a", "b", "c"].flatMap((id) => [0, 1, 2, 3].map((s) => `${id}:${s}`)),
    ]);
    // And every row is accounted for by exactly one request.
    expect(
      requests.flatMap(({ entries }) => entries.map(({ row }) => row.id)),
    ).toEqual(["a", "b", "c"]);
  });

  test("no request exceeds the budget while rows still fit whole", () => {
    const group = Array.from({ length: 12 }, (_, index) =>
      builtRow(`row-${index}`, 5, "x".repeat(200)),
    );
    const maxBytes = 4000;

    for (const { ndjson } of splitIngestRequests(group, maxBytes).unwrap()) {
      expect(utf8Bytes(ndjson)).toBeLessThanOrEqual(maxBytes);
    }
  });

  test("an oversized row is split across bounded requests with row metadata on each part", () => {
    const group = [builtRow("a", 20, "x".repeat(100)), builtRow("b", 1, "x")];

    const requests = splitIngestRequests(group, 500).unwrap();

    expect(requests.length).toBeGreaterThan(2);
    for (const { entries, ndjson } of requests) {
      expect(utf8Bytes(ndjson)).toBeLessThanOrEqual(500);
      const ndjsonDocs = ndjson.split("\n").map((line) => JSON.parse(line));
      expect(entries.flatMap(({ docs }) => docs)).toEqual(ndjsonDocs);
      expect(entries.map(({ row }) => row.id)).toContain(
        ndjsonDocs[0]?.document_id,
      );
    }
    expect(ingestedIds(requests)).toEqual([
      ...Array.from({ length: 20 }, (_, seq) => `a:${seq}`),
      "b:0",
    ]);
  });

  test("a single document larger than the budget fails explicitly", () => {
    const group = [builtRow("huge", 1, "x".repeat(500))];

    const outcome = splitIngestRequests(group, 100);
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) {
      expect(outcome.error.message).toContain(
        "exceeding the 100-byte document limit",
      );
    }
  });

  test("a larger allowed document occupies its own request", () => {
    const oversized = builtRow("large", 1, "x".repeat(120));
    const group = [
      builtRow("before", 1, "x"),
      oversized,
      builtRow("after", 1, "x"),
    ];
    const requests = splitIngestRequests(group, 100, {
      maxSingleDocumentBytes: 200,
    }).unwrap();

    expect(
      requests.map(({ entries }) => entries.map(({ row }) => row.id)),
    ).toEqual([["before"], ["large"], ["after"]]);
    expect(utf8Bytes(requests[1]?.ndjson ?? "")).toBeGreaterThan(100);
    expect(ingestedIds(requests)).toEqual(["before:0", "large:0", "after:0"]);
  });

  test("the budget counts UTF-8 bytes, not code units", () => {
    // Czech/Slovak/Arabic legal text is multi-byte; sizing on `.length` would
    // under-count the wire body by up to 3x and defeat the bound.
    const group = [builtRow("cz", 1, "ř".repeat(300))];
    const [request] = splitIngestRequests(group, 1_000_000).unwrap();
    const ndjson = request?.ndjson ?? "";

    expect(utf8Bytes(ndjson)).toBeGreaterThan(ndjson.length);
  });

  test("an empty group produces no requests", () => {
    expect(splitIngestRequests([], 1000).unwrap()).toEqual([]);
  });

  test("a row without documents is rejected before building a request", () => {
    expect(() =>
      splitIngestRequests([{ row: { id: "empty" }, docs: [] }], 1000),
    ).toThrow("An ingest row has no documents");
  });
});

describe("settleBoth", () => {
  test("a fast failure waits for its sibling before surfacing", async () => {
    let siblingFinished = false;
    const sibling = sleep(25).then(() => {
      siblingFinished = true;
      return "loaded";
    });

    const caught = await settleBoth(
      Promise.reject(new Error("boom")),
      sibling,
    ).catch((error: unknown) => error);

    expect(caught instanceof Error ? caught.message : null).toBe("boom");
    // The point of the helper: the paired corpus read is finished, so the
    // caller's next slice cannot start on top of a request still in flight and
    // drift past the concurrency bound.
    expect(siblingFinished).toBe(true);
  });

  test("the first failure in argument order wins", async () => {
    const caught = await settleBoth(
      Promise.reject(new Error("text read")),
      Promise.reject(new Error("ast read")),
    ).catch((error: unknown) => error);

    expect(caught instanceof Error ? caught.message : null).toBe("text read");
  });

  test("both values are returned in order when neither fails", async () => {
    expect(
      await settleBoth(Promise.resolve("text"), Promise.resolve(null)),
    ).toEqual(["text", null]);
  });
});
