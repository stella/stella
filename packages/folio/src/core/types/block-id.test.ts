import { describe, expect, test } from "bun:test";

import {
  deriveBlockId,
  getFolioParaIdFromBlockId,
  isFolioBlockId,
  isSequentialFolioBlockId,
} from "./block-id";

describe("deriveBlockId", () => {
  test("returns the source paraId when present and unused", () => {
    const id = deriveBlockId({
      paraId: "AAAA0001",
      index: 1,
      taken: new Set(),
    });
    expect(id as string).toBe("AAAA0001");
  });

  test("falls back to seq-NNNN when paraId is null", () => {
    const id = deriveBlockId({ paraId: null, index: 7, taken: new Set() });
    expect(id as string).toBe("seq-0007");
  });

  test("falls back to seq-NNNN when paraId is empty", () => {
    const id = deriveBlockId({ paraId: "", index: 7, taken: new Set() });
    expect(id as string).toBe("seq-0007");
  });

  test("bumps the sequential fallback past collisions with prior ids", () => {
    const taken = new Set<string>(["seq-0003"]);
    const id = deriveBlockId({ paraId: null, index: 3, taken });
    expect(id as string).toBe("seq-0004");
  });

  test("falls back to seq when source paraId collides with a prior id", () => {
    const taken = new Set<string>(["AAAA0001"]);
    const id = deriveBlockId({
      paraId: "AAAA0001",
      index: 2,
      taken,
    });
    expect(id as string).toBe("seq-0002");
  });

  test("derives the same ids in the same order for the same inputs", () => {
    // The whole point of the shared generator: server and client
    // walking the same paragraphs must agree.
    const paragraphs = [
      { paraId: "AAAA0001" },
      { paraId: null },
      { paraId: "AAAA0002" },
      { paraId: null },
      { paraId: "AAAA0001" }, // duplicate source paraId
    ];
    const run = () => {
      const taken = new Set<string>();
      return paragraphs.map((p, i) => {
        const id = deriveBlockId({
          paraId: p.paraId,
          index: i + 1,
          taken,
        });
        taken.add(id);
        return id;
      });
    };
    const first = run();
    const second = run();
    expect(first).toEqual(second);
    expect(first as string[]).toEqual([
      "AAAA0001",
      "seq-0002",
      "AAAA0002",
      "seq-0004",
      "seq-0005",
    ]);
  });
});

describe("isSequentialFolioBlockId", () => {
  test("matches seq-NNNN ids", () => {
    expect(
      isSequentialFolioBlockId(
        deriveBlockId({ paraId: null, index: 1, taken: new Set() }),
      ),
    ).toBe(true);
  });

  test("rejects paraId-shaped ids", () => {
    expect(
      isSequentialFolioBlockId(
        deriveBlockId({ paraId: "AAAA0001", index: 1, taken: new Set() }),
      ),
    ).toBe(false);
  });
});

describe("getFolioParaIdFromBlockId", () => {
  test("returns the underlying paraId for paraId-shaped ids", () => {
    expect(
      getFolioParaIdFromBlockId(
        deriveBlockId({ paraId: "AAAA0001", index: 1, taken: new Set() }),
      ),
    ).toBe("AAAA0001");
  });

  test("returns null for seq-NNNN ids", () => {
    expect(
      getFolioParaIdFromBlockId(
        deriveBlockId({ paraId: null, index: 1, taken: new Set() }),
      ),
    ).toBeNull();
  });
});

describe("isFolioBlockId", () => {
  test("accepts seq-NNNN", () => {
    expect(isFolioBlockId("seq-0001")).toBe(true);
  });

  test("accepts any non-empty non-seq string (paraId-shaped)", () => {
    expect(isFolioBlockId("AAAA0001")).toBe(true);
  });

  test("accepts legacy b-NNNN ids structurally (paraId-shaped)", () => {
    // `isFolioBlockId` only enforces the structural shape — anything
    // non-empty that isn't a malformed `seq-` is accepted, because
    // `deriveBlockId` is allowed to emit arbitrary `w14:paraId`
    // strings verbatim. The structural divergence guard is the
    // shared `deriveBlockId` itself, not this runtime check. Legacy
    // `b-NNNN` rows are rejected at the data-migration layer, not
    // here.
    expect(isFolioBlockId("b-0271")).toBe(true);
  });

  test("rejects malformed sequential ids", () => {
    expect(isFolioBlockId("seq-")).toBe(false);
    expect(isFolioBlockId("seq-abc")).toBe(false);
  });

  test("rejects non-strings and empty strings", () => {
    expect(isFolioBlockId("")).toBe(false);
    expect(isFolioBlockId(undefined)).toBe(false);
    expect(isFolioBlockId(null)).toBe(false);
    expect(isFolioBlockId(42)).toBe(false);
  });
});
